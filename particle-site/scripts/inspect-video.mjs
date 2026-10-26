import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ISO BMFF 容器检查；不解码画面，不推测录制目标帧率。
// 结构参考：https://www.w3.org/TR/mse-byte-stream-format-isobmff/
// 字段标志参考：https://github.com/axiomatic-systems/Bento4/tree/master/Source/C%2B%2B/Core
// 独立实现，仅使用 Node 内置 API。

function safeNumber(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} 超出安全整数范围。`);
  return number;
}

function boxes(buffer, start = 0, end = buffer.length) {
  const result = [];
  for (let offset = start; offset < end;) {
    if (end - offset < 8) throw new Error(`偏移 ${offset} 的 MP4 box 头不完整。`);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    let size = buffer.readUInt32BE(offset);
    let headerSize = 8;
    if (size === 1) {
      if (end - offset < 16) throw new Error(`${type} 的扩展长度不完整。`);
      size = safeNumber(buffer.readBigUInt64BE(offset + 8), `${type} 长度`);
      headerSize = 16;
    } else if (size === 0) size = end - offset;
    if (type === 'uuid') headerSize += 16;
    if (size < headerSize || offset + size > end) throw new Error(`${type} 长度无效或文件已截断。`);
    result.push({ type, offset, size, body: offset + headerSize, end: offset + size });
    offset += size;
  }
  return result;
}

function children(buffer, box) { return box ? boxes(buffer, box.body, box.end) : []; }
function child(buffer, box, type) { return children(buffer, box).find((entry) => entry.type === type); }
function need(box, offset, length) {
  if (!box || offset < box.body || offset + length > box.end) throw new Error(`${box?.type ?? 'box'} 字段不完整。`);
}
function u32(buffer, box, relative) { const offset = box.body + relative; need(box, offset, 4); return buffer.readUInt32BE(offset); }
function u64(buffer, box, relative) { const offset = box.body + relative; need(box, offset, 8); return safeNumber(buffer.readBigUInt64BE(offset), `${box.type} 时间或偏移`); }
function fullHeader(buffer, box) {
  need(box, box.body, 4);
  return { version: buffer[box.body], flags: buffer.readUIntBE(box.body + 1, 3) };
}
function timedHeader(buffer, box) {
  if (!box) return { timescale: null, durationTicks: null };
  const { version } = fullHeader(buffer, box);
  if (version !== 0 && version !== 1) throw new Error(`${box.type} 版本 ${version} 暂不支持。`);
  const timescale = u32(buffer, box, version === 1 ? 20 : 12);
  const durationOffset = version === 1 ? 24 : 16;
  need(box, box.body + durationOffset, version === 1 ? 8 : 4);
  const raw = version === 1 ? buffer.readBigUInt64BE(box.body + durationOffset) : BigInt(u32(buffer, box, durationOffset));
  const unknown = version === 1 ? 0xffffffffffffffffn : 0xffffffffn;
  return { timescale, durationTicks: raw === unknown ? null : safeNumber(raw, `${box.type} 时长`) };
}
function seconds(ticks, scale) { return ticks === null || !scale ? null : ticks / scale; }

function parseDescriptions(buffer, stsd) {
  if (!stsd) return [];
  const count = u32(buffer, stsd, 4);
  const entries = boxes(buffer, stsd.body + 8, stsd.end);
  if (entries.length !== count) throw new Error('stsd 的样本描述数量与实际记录不一致。');
  return entries.map((entry) => {
    const description = { type: entry.type, codec: entry.type, width: null, height: null };
    // VisualSampleEntry 固定字段 78 字节；无需解析音频 SampleEntry。
    if (['avc1', 'avc2', 'avc3', 'avc4', 'hvc1', 'hev1', 'vp08', 'vp09', 'av01', 'mp4v', 'encv'].includes(entry.type)) {
      need(entry, entry.body, 78);
      description.width = buffer.readUInt16BE(entry.body + 24);
      description.height = buffer.readUInt16BE(entry.body + 26);
      const avc = boxes(buffer, entry.body + 78, entry.end).find((box) => box.type === 'avcC');
      if (avc) {
        need(avc, avc.body, 4);
        description.codec = `${entry.type}.${buffer.subarray(avc.body + 1, avc.body + 4).toString('hex')}`;
      }
    }
    return description;
  });
}

function parseSampleTable(buffer, stbl) {
  const stts = child(buffer, stbl, 'stts');
  let timingSamples = 0;
  let durationTicks = 0;
  const durationHistogram = new Map();
  if (stts) {
    const entryCount = u32(buffer, stts, 4);
    need(stts, stts.body + 8, entryCount * 8);
    for (let index = 0; index < entryCount; index++) {
      const count = u32(buffer, stts, 8 + index * 8);
      const duration = u32(buffer, stts, 12 + index * 8);
      timingSamples = safeNumber(timingSamples + count, 'stts 样本数');
      durationTicks = safeNumber(durationTicks + count * duration, 'stts 样本时长');
      durationHistogram.set(duration, (durationHistogram.get(duration) ?? 0) + count);
    }
  }
  const stsz = child(buffer, stbl, 'stsz');
  const stz2 = child(buffer, stbl, 'stz2');
  let sampleCount = null;
  let sampleBytes = null;
  if (stsz) {
    const uniformSize = u32(buffer, stsz, 4);
    sampleCount = u32(buffer, stsz, 8);
    sampleBytes = 0;
    if (uniformSize) sampleBytes = safeNumber(sampleCount * uniformSize, 'stsz 样本大小');
    else {
      need(stsz, stsz.body + 12, sampleCount * 4);
      for (let index = 0; index < sampleCount; index++) sampleBytes = safeNumber(sampleBytes + u32(buffer, stsz, 12 + index * 4), 'stsz 样本大小');
    }
  } else if (stz2) {
    need(stz2, stz2.body, 12);
    const fieldBits = buffer[stz2.body + 7];
    sampleCount = u32(buffer, stz2, 8);
    if (![4, 8, 16].includes(fieldBits)) throw new Error(`stz2 的 ${fieldBits} 位样本大小暂不支持。`);
    need(stz2, stz2.body + 12, Math.ceil(sampleCount * fieldBits / 8));
    sampleBytes = 0;
    for (let index = 0; index < sampleCount; index++) {
      const offset = stz2.body + 12 + Math.floor(index * fieldBits / 8);
      const size = fieldBits === 16 ? buffer.readUInt16BE(offset) : fieldBits === 8 ? buffer[offset] : (index % 2 ? buffer[offset] & 15 : buffer[offset] >>> 4);
      sampleBytes = safeNumber(sampleBytes + size, 'stz2 样本大小');
    }
  }
  sampleCount ??= timingSamples;
  return {
    sampleCount, timingSamples, durationTicks,
    durationComplete: sampleCount === timingSamples,
    sampleBytes, durationHistogram,
    compositionOffsetsPresent: Boolean(child(buffer, stbl, 'ctts')),
  };
}

function parseTfhd(buffer, box, defaults) {
  const { version, flags } = fullHeader(buffer, box);
  if (version !== 0 || flags & ~0x03003b) throw new Error('tfhd 含有暂不支持的版本或标志。');
  const trackId = u32(buffer, box, 4);
  let cursor = 8;
  let baseDataOffset = null;
  let defaultDuration = defaults?.duration ?? null;
  let defaultSize = defaults?.size ?? null;
  if (flags & 1) { baseDataOffset = u64(buffer, box, cursor); cursor += 8; }
  if (flags & 2) { u32(buffer, box, cursor); cursor += 4; }
  if (flags & 8) { defaultDuration = u32(buffer, box, cursor); cursor += 4; }
  if (flags & 16) { defaultSize = u32(buffer, box, cursor); cursor += 4; }
  if (flags & 32) u32(buffer, box, cursor);
  return { trackId, flags, baseDataOffset, defaultDuration, defaultSize };
}

function parseTrun(buffer, box, header) {
  const { version, flags } = fullHeader(buffer, box);
  if (version > 1 || flags & ~0x000f05) throw new Error('trun 含有暂不支持的版本或标志。');
  const sampleCount = u32(buffer, box, 4);
  let cursor = 8;
  let dataOffset = null;
  if (flags & 1) { need(box, box.body + cursor, 4); dataOffset = buffer.readInt32BE(box.body + cursor); cursor += 4; }
  if (flags & 4) { u32(buffer, box, cursor); cursor += 4; }
  const stride = [0x100, 0x200, 0x400, 0x800].filter((flag) => flags & flag).length * 4;
  need(box, box.body + cursor, sampleCount * stride);
  let durationTicks = 0;
  let missingDurationSamples = 0;
  let sampleBytes = 0;
  let missingSizeSamples = 0;
  let compositionOffsetsPresent = false;
  const histogram = new Map();
  const addDuration = (duration, count) => {
    if (duration === null) missingDurationSamples += count;
    else {
      durationTicks = safeNumber(durationTicks + duration * count, 'trun 样本时长');
      histogram.set(duration, (histogram.get(duration) ?? 0) + count);
    }
  };
  // flags = 0 合法：样本时长和大小来自 tfhd / trex，无每样本字段。
  if (stride === 0) {
    addDuration(header.defaultDuration > 0 ? header.defaultDuration : null, sampleCount);
    if (header.defaultSize > 0) sampleBytes = safeNumber(header.defaultSize * sampleCount, 'trun 样本大小');
    else missingSizeSamples = sampleCount;
  } else {
    for (let index = 0; index < sampleCount; index++) {
      const duration = flags & 0x100 ? u32(buffer, box, cursor) : header.defaultDuration > 0 ? header.defaultDuration : null;
      if (flags & 0x100) cursor += 4;
      addDuration(duration, 1);
      const size = flags & 0x200 ? u32(buffer, box, cursor) : header.defaultSize > 0 ? header.defaultSize : null;
      if (flags & 0x200) cursor += 4;
      if (size === null) missingSizeSamples++;
      else sampleBytes = safeNumber(sampleBytes + size, 'trun 样本大小');
      if (flags & 0x400) cursor += 4;
      if (flags & 0x800) {
        need(box, box.body + cursor, 4);
        const offset = version === 1 ? buffer.readInt32BE(box.body + cursor) : buffer.readUInt32BE(box.body + cursor);
        compositionOffsetsPresent ||= offset !== 0;
        cursor += 4;
      }
    }
  }
  return { sampleCount, durationTicks, missingDurationSamples, sampleBytes, missingSizeSamples, dataOffset, compositionOffsetsPresent, histogram };
}

export function inspectMp4(buffer, file = null) {
  const top = boxes(buffer);
  const moov = top.find((box) => box.type === 'moov');
  if (!moov || !top.some((box) => box.type === 'ftyp')) throw new Error('文件不是包含完整 moov 与 ftyp 的 MP4。');
  const movie = timedHeader(buffer, child(buffer, moov, 'mvhd'));
  const mdats = top.filter((box) => box.type === 'mdat');
  const defaults = new Map();
  for (const trex of children(buffer, child(buffer, moov, 'mvex')).filter((box) => box.type === 'trex')) {
    defaults.set(u32(buffer, trex, 4), { duration: u32(buffer, trex, 12), size: u32(buffer, trex, 16) });
  }
  const tracks = [];
  for (const trak of children(buffer, moov).filter((box) => box.type === 'trak')) {
    const tkhd = child(buffer, trak, 'tkhd');
    if (!tkhd) throw new Error('轨道缺少 tkhd。');
    const { version } = fullHeader(buffer, tkhd);
    if (version > 1) throw new Error('tkhd 版本暂不支持。');
    const id = u32(buffer, tkhd, version === 1 ? 20 : 12);
    const mdia = child(buffer, trak, 'mdia');
    const hdlr = child(buffer, mdia, 'hdlr');
    if (!hdlr) throw new Error(`轨道 ${id} 缺少 hdlr。`);
    need(hdlr, hdlr.body + 8, 4);
    const handler = buffer.toString('latin1', hdlr.body + 8, hdlr.body + 12);
    const media = timedHeader(buffer, child(buffer, mdia, 'mdhd'));
    if (!media.timescale) throw new Error(`轨道 ${id} 的 mdhd 时间刻度无效。`);
    const stbl = child(buffer, child(buffer, mdia, 'minf'), 'stbl');
    const base = parseSampleTable(buffer, stbl);
    const descriptions = parseDescriptions(buffer, child(buffer, stbl, 'stsd'));
    const displayWidth = u32(buffer, tkhd, version === 1 ? 88 : 76) / 65536;
    const displayHeight = u32(buffer, tkhd, version === 1 ? 92 : 80) / 65536;
    const warnings = [];
    if (!base.durationComplete) warnings.push('stsz / stz2 与 stts 的样本数不一致，无法完整确定样本时长。');
    tracks.push({
      id, handler, timescale: media.timescale, declaredDurationTicks: media.durationTicks,
      width: descriptions[0]?.width || displayWidth, height: descriptions[0]?.height || displayHeight,
      displayWidth, displayHeight, descriptions,
      base, frameCount: base.sampleCount, knownDurationTicks: base.durationTicks,
      missingDurationSamples: base.durationComplete ? 0 : base.sampleCount,
      sampleBytes: base.sampleBytes ?? 0, missingSizeSamples: base.sampleBytes === null ? base.sampleCount : 0,
      decodeStart: base.sampleCount && base.durationComplete ? 0 : null,
      decodeEnd: base.sampleCount && base.durationComplete ? base.durationTicks : null,
      previousEnd: base.durationComplete ? base.durationTicks : null,
      histogram: new Map(base.durationHistogram), compositionOffsetsPresent: base.compositionOffsetsPresent,
      fragments: [], gaps: [], overlaps: [], warnings,
    });
  }

  for (const moof of top.filter((box) => box.type === 'moof')) {
    const mfhd = child(buffer, moof, 'mfhd');
    const sequence = mfhd ? u32(buffer, mfhd, 4) : null;
    const trafs = children(buffer, moof).filter((box) => box.type === 'traf');
    for (let trafIndex = 0; trafIndex < trafs.length; trafIndex++) {
      const traf = trafs[trafIndex];
      const tfhd = child(buffer, traf, 'tfhd');
      if (!tfhd) throw new Error('traf 缺少 tfhd。');
      const id = u32(buffer, tfhd, 4);
      const track = tracks.find((entry) => entry.id === id);
      if (!track) throw new Error(`片段引用不存在的轨道 ${id}。`);
      const header = parseTfhd(buffer, tfhd, defaults.get(id));
      const tfdt = child(buffer, traf, 'tfdt');
      let decodeStart = track.previousEnd;
      if (tfdt) {
        const { version } = fullHeader(buffer, tfdt);
        if (version > 1) throw new Error('tfdt 版本暂不支持。');
        decodeStart = version === 1 ? u64(buffer, tfdt, 4) : u32(buffer, tfdt, 4);
      } else track.warnings.push(`片段 ${sequence ?? moof.offset} 无 tfdt，时间从前一片段结束处推导，无法验证其时间间隙。`);
      if (tfdt && track.previousEnd !== null && decodeStart !== null) {
        const delta = decodeStart - track.previousEnd;
        if (delta > 0) track.gaps.push({ sequence, ticks: delta, seconds: delta / track.timescale });
        else if (delta < 0) track.overlaps.push({ sequence, ticks: -delta, seconds: -delta / track.timescale });
      }
      const baseData = header.baseDataOffset ?? ((header.flags & 0x20000 || trafIndex === 0) ? moof.offset : null);
      let nextData = null;
      let fragmentCount = 0;
      let fragmentDuration = 0;
      let fragmentMissing = 0;
      const runs = [];
      for (const trun of children(buffer, traf).filter((box) => box.type === 'trun')) {
        const run = parseTrun(buffer, trun, header);
        const start = run.dataOffset !== null && baseData !== null ? baseData + run.dataOffset : nextData;
        const end = start !== null && !run.missingSizeSamples ? start + run.sampleBytes : null;
        const dataRangeValid = start !== null && end !== null ? mdats.some((mdat) => start >= mdat.body && end <= mdat.end) : null;
        if (dataRangeValid === false) throw new Error(`轨道 ${id} 的片段 ${sequence} 样本引用超出 mdat，文件可能不完整。`);
        nextData = end;
        runs.push({
          samples: run.sampleCount, durationTicks: run.missingDurationSamples ? null : run.durationTicks,
          durationSeconds: run.missingDurationSamples ? null : run.durationTicks / track.timescale,
          missingDurationSamples: run.missingDurationSamples,
          sampleBytes: run.missingSizeSamples ? null : run.sampleBytes,
          dataStart: start, dataEnd: end, dataRangeValid,
        });
        fragmentCount = safeNumber(fragmentCount + run.sampleCount, '片段样本数');
        fragmentDuration = safeNumber(fragmentDuration + run.durationTicks, '片段时长');
        fragmentMissing += run.missingDurationSamples;
        track.sampleBytes = safeNumber(track.sampleBytes + run.sampleBytes, '轨道样本大小');
        track.missingSizeSamples += run.missingSizeSamples;
        track.compositionOffsetsPresent ||= run.compositionOffsetsPresent;
        for (const [duration, count] of run.histogram) track.histogram.set(duration, (track.histogram.get(duration) ?? 0) + count);
      }
      const decodeEnd = decodeStart === null || fragmentMissing ? null : safeNumber(decodeStart + fragmentDuration, '片段结束时间');
      if (decodeStart !== null) track.decodeStart = track.decodeStart === null ? decodeStart : Math.min(track.decodeStart, decodeStart);
      if (decodeEnd !== null) track.decodeEnd = track.decodeEnd === null ? decodeEnd : Math.max(track.decodeEnd, decodeEnd);
      track.previousEnd = decodeEnd;
      track.frameCount = safeNumber(track.frameCount + fragmentCount, '轨道样本数');
      track.knownDurationTicks = safeNumber(track.knownDurationTicks + fragmentDuration, '轨道时长');
      track.missingDurationSamples += fragmentMissing;
      track.fragments.push({
        sequence, moofOffset: moof.offset, samples: fragmentCount,
        decodeTimeSource: tfdt ? 'tfdt' : 'previous-fragment-end',
        decodeStartTicks: decodeStart, decodeEndTicks: decodeEnd,
        startSeconds: seconds(decodeStart, track.timescale), endSeconds: seconds(decodeEnd, track.timescale), runs,
      });
    }
  }

  const reports = tracks.map((track) => {
    const complete = track.missingDurationSamples === 0;
    const sampleDurationSeconds = complete ? track.knownDurationTicks / track.timescale : null;
    const durationSeconds = complete && track.decodeStart !== null && track.decodeEnd !== null ? (track.decodeEnd - track.decodeStart) / track.timescale : null;
    const declaredDurationSeconds = seconds(track.declaredDurationTicks, track.timescale);
    if (durationSeconds !== null && declaredDurationSeconds !== null && Math.abs(durationSeconds - declaredDurationSeconds) > 1 / track.timescale) {
      track.warnings.push('mdhd 声明时长与实际样本时间线不同；本报告采用 stts / tfdt / trun 的实际时间。');
    }
    if (track.missingDurationSamples) track.warnings.push('部分样本没有有效时长，帧率返回 null，不使用目标 30 FPS 补值。');
    if (track.compositionOffsetsPresent) track.warnings.push('存在合成时间偏移；这里报告解码时间线时长，未应用 ctts / elst 的展示时间变换。');
    return {
      trackId: track.id, handler: track.handler, timescale: track.timescale,
      codec: track.descriptions[0]?.codec ?? null, sampleDescriptions: track.descriptions,
      width: track.width, height: track.height, displayWidth: track.displayWidth, displayHeight: track.displayHeight,
      frameCount: track.frameCount, baseSampleCount: track.base.sampleCount,
      durationSeconds, durationBasis: 'stts / tfdt / trun decode timeline',
      sampleDurationSeconds, knownSampleDurationSeconds: track.knownDurationTicks / track.timescale,
      declaredDurationSeconds, startSeconds: seconds(track.decodeStart, track.timescale), endSeconds: seconds(track.decodeEnd, track.timescale),
      averageEncodedFps: durationSeconds > 0 && complete ? track.frameCount / durationSeconds : null,
      sampleDurationAverageFps: sampleDurationSeconds > 0 ? track.frameCount / sampleDurationSeconds : null,
      sampleBytes: track.missingSizeSamples ? null : track.sampleBytes,
      missingDurationSamples: track.missingDurationSamples, missingSizeSamples: track.missingSizeSamples,
      sampleDurations: [...track.histogram].sort(([left], [right]) => left - right).map(([ticks, count]) => ({ ticks, seconds: ticks / track.timescale, count })),
      fragmentCount: track.fragments.length, fragments: track.fragments,
      gaps: track.gaps, overlaps: track.overlaps, warnings: [...new Set(track.warnings)],
    };
  });
  const videos = reports.filter((track) => track.handler === 'vide');
  if (videos.length === 0) throw new Error('MP4 中没有视频轨道。');
  const video = videos[0];
  return {
    file, fileBytes: buffer.length, container: 'MP4', fragmented: top.some((box) => box.type === 'moof'),
    summary: videos.length === 1 ? {
      width: video.width, height: video.height, codec: video.codec, encodedFrames: video.frameCount,
      durationSeconds: video.durationSeconds, averageEncodedFps: video.averageEncodedFps,
      sampleDurationSeconds: video.sampleDurationSeconds, fragmentCount: video.fragmentCount,
      decodeGapCount: video.gaps.length, decodeOverlapCount: video.overlaps.length,
    } : null,
    movieDeclaredDurationSeconds: seconds(movie.durationTicks, movie.timescale),
    mediaDataBytes: mdats.reduce((total, box) => total + box.end - box.body, 0),
    videoTrackCount: videos.length, audioTrackCount: reports.filter((track) => track.handler === 'soun').length,
    videoTracks: videos,
    otherTracks: reports.filter((track) => track.handler !== 'vide'),
    topLevelBoxes: top.map(({ type, offset, size }) => ({ type, offset, size })),
    limitation: '读取容器样本及时间戳，未解码图像；画面内容、可播放性与拖动进度需在浏览器播放器另行验证。',
  };
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const input = arguments_[0];
  const outputIndex = arguments_.indexOf('--output');
  const output = outputIndex >= 0 ? arguments_[outputIndex + 1] : null;
  if (!input || input.startsWith('--') || outputIndex >= 0 && !output) {
    console.error('用法：node scripts/inspect-video.mjs 文件.mp4 [--output 报告.json]');
    process.exitCode = 1;
    return;
  }
  try {
    const file = resolve(input);
    const report = inspectMp4(await readFile(file), file);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (output) await writeFile(resolve(output), json, 'utf8');
    process.stdout.write(json);
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
