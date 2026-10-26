import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { Pause, Play, Plus, Repeat2, Trash2 } from 'lucide-react';
import { captureKeyframe, clipLoopSeam, normalizeClip, retimeClip, sampleClip, updateKeyframe } from './animation';
import type { AnimationClip, AnimationInterpolation, AnimationKeyframe, AnimationSample } from './animation';

export interface TimelinePanelProps {
  clip: AnimationClip;
  time: number;
  playing: boolean;
  loop: boolean;
  onClipChange: (clip: AnimationClip) => void;
  onSeek: (time: number) => void;
  onTogglePlay: () => void;
  onLoopChange: (loop: boolean) => void;
  /** 传入时，新增关键帧捕获当前实际画面（包括手动调整后的形态）。 */
  currentSample?: AnimationSample;
  /** 直接读取引擎此刻的时间与姿态，避免播放中打帧捕获陈旧的 React 快照。 */
  getCurrentFrame?: () => { time: number; sample: AnimationSample };
  disabled?: boolean;
}

interface NumberFieldProps {
  label: string;
  value: number;
  unit: string;
  minimum: number;
  maximum: number;
  step: number;
  disabled?: boolean;
  commitOnBlur?: boolean;
  onChange: (value: number) => void | boolean;
}

function NumberField({ label, value, unit, minimum, maximum, step, disabled, commitOnBlur = false, onChange }: NumberFieldProps) {
  const [draft, setDraft] = useState(String(Number(value.toFixed(2))));
  const editing = useRef(false);
  const dirty = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(String(Number(value.toFixed(2))));
  }, [value]);
  const commit = () => {
    editing.current = false;
    if (cancelled.current || !dirty.current) {
      cancelled.current = false;
      dirty.current = false;
      setDraft(String(Number(value.toFixed(2))));
      return;
    }
    dirty.current = false;
    const parsed = draft.trim() === '' ? value : Number(draft);
    const next = Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : value;
    const accepted = next === value || onChange(next) !== false;
    setDraft(String(Number((accepted ? next : value).toFixed(2))));
  };
  return <label className="timeline-number-field">
    <span>{label}</span>
    <div className="timeline-number-input">
      <input type="number" aria-label={label} min={minimum} max={maximum} step={step} value={draft} disabled={disabled}
        title={commitOnBlur ? '输入后按回车或离开输入框确认，Esc 取消' : '实时生效；回车确认输入'}
        onFocus={() => { editing.current = true; dirty.current = false; }}
        onChange={(event) => {
          dirty.current = true;
          setDraft(event.target.value);
          const number = event.target.valueAsNumber;
          if (!commitOnBlur && Number.isFinite(number) && number >= minimum && number <= maximum) onChange(number);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
          if (event.key === 'Escape') { event.preventDefault(); cancelled.current = true; event.currentTarget.blur(); }
        }} />
      <small>{unit}</small>
    </div>
  </label>;
}

let frameSequence = 0;
function uniqueFrameId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? `key-${crypto.randomUUID()}`
    : `key-${Date.now().toString(36)}-${++frameSequence}`;
}

const LANES = [
  { id: 'shape', label: '形态' },
  { id: 'scale', label: '缩放' },
  { id: 'rotation', label: '旋转' },
];

export function TimelinePanel({
  clip: inputClip, time, playing, loop, onClipChange, onSeek, onTogglePlay, onLoopChange, currentSample, getCurrentFrame, disabled = false,
}: TimelinePanelProps) {
  const clip = useMemo(() => normalizeClip(inputClip), [inputClip]);
  const [selectedId, setSelectedId] = useState(clip.keyframes[0].id);
  const scrubPointer = useRef<number | null>(null);
  const editor = useRef<HTMLFieldSetElement>(null);
  const [message, setMessage] = useState('');
  const selected = clip.keyframes.find((frame) => frame.id === selectedId) ?? clip.keyframes[0];
  const currentTime = Math.max(0, Math.min(clip.duration, Number.isFinite(time) ? time : 0));
  const tickCount = Math.min(8, Math.max(3, Math.ceil(clip.duration)));
  const seam = useMemo(() => clipLoopSeam(clip), [clip]);
  useEffect(() => {
    if (!clip.keyframes.some((frame) => frame.id === selectedId)) setSelectedId(clip.keyframes[0].id);
  }, [clip, selectedId]);

  useEffect(() => { setMessage(''); }, [inputClip]);
  const seek = (next: number) => {
    if (disabled || !Number.isFinite(next)) return;
    // onSeek 是幂等暂停；连续 pointermove 不使用 toggle，避免 React 快照延迟反复恢复播放。
    onSeek(Math.max(0, Math.min(clip.duration, next)));
  };
  const select = (frame: AnimationKeyframe, lane: string) => {
    if (disabled) return;
    setSelectedId(frame.id);
    seek(frame.time);
    requestAnimationFrame(() => {
      const label = lane === 'shape' ? '关键帧形态' : lane === 'scale' ? '缩放' : '旋转 X';
      editor.current?.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)?.focus({ preventScroll: true });
    });
  };
  const seekTrack = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width > 0) seek((event.clientX - bounds.left) / bounds.width * clip.duration);
  };
  const startTrackScrub = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    scrubPointer.current = event.pointerId;
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    seekTrack(event);
  };
  const finishTrackScrub = (event: PointerEvent<HTMLDivElement>) => {
    if (scrubPointer.current !== event.pointerId) return;
    scrubPointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const keyTrackScrub = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || event.target !== event.currentTarget) return;
    const step = event.shiftKey ? 0.1 : 0.01;
    const next = event.key === 'ArrowLeft' ? currentTime - step : event.key === 'ArrowRight' ? currentTime + step
      : event.key === 'PageDown' ? currentTime - 1 : event.key === 'PageUp' ? currentTime + 1
        : event.key === 'Home' ? 0 : event.key === 'End' ? clip.duration : null;
    if (next !== null) { event.preventDefault(); seek(next); }
  };
  const editFrame = (patch: Partial<AnimationKeyframe>): boolean => {
    if (disabled) return false;
    const result = updateKeyframe(clip, selected.id, patch);
    if (result.error) { setMessage(result.error); return false; }
    setMessage('');
    const updated = result.clip.keyframes.find((frame) => frame.id === selected.id)!;
    onClipChange(result.clip);
    // 编辑框对应选中帧；即使播放头已移动，也立即展示该帧的准确姿态。
    onSeek(updated.time);
    return true;
  };
  const addFrame = () => {
    if (disabled) return;
    const current = getCurrentFrame?.() ?? { time: currentTime, sample: currentSample ?? sampleClip(clip, currentTime) };
    const result = captureKeyframe(clip, current.time, current.sample, uniqueFrameId());
    onClipChange(result.clip);
    setSelectedId(result.frame.id);
    onSeek(result.frame.time);
  };
  const deleteFrame = () => {
    if (disabled || clip.keyframes.length <= 1) return;
    const remaining = clip.keyframes.filter((frame) => frame.id !== selected.id);
    const next = remaining.reduce((closest, frame) => Math.abs(frame.time - currentTime) < Math.abs(closest.time - currentTime) ? frame : closest);
    onClipChange(normalizeClip({ ...clip, keyframes: remaining }));
    setSelectedId(next.id);
    // 删除关键帧后仍停在原播放头，展示移除该帧后的插值，而非跳到下一帧。
    onSeek(currentTime);
  };
  const changeDuration = (duration: number) => {
    if (disabled) return;
    const next = retimeClip(clip, duration);
    onClipChange(next);
    onSeek(currentTime / clip.duration * next.duration);
  };

  return <section className={`animation-timeline ${disabled ? 'is-disabled' : ''}`} aria-label="动画时间轴">
    <div className="timeline-toolbar">
      <div className="timeline-title"><span>ANIMATION</span><strong>动画时间轴</strong></div>
      <div className="timeline-playback">
        <button className={`timeline-play ${playing ? 'is-playing' : ''}`} aria-label={playing ? '暂停时间轴播放' : '播放时间轴'} disabled={disabled} onClick={onTogglePlay}>
          {playing ? <Pause size={13} /> : <Play size={13} />}<span>{playing ? '暂停' : '播放'}</span>
        </button>
        <button className={`timeline-loop ${loop ? 'is-active' : ''}`} aria-label="循环播放时间轴" role="switch" aria-checked={loop} disabled={disabled} onClick={() => onLoopChange(!loop)}>
          <Repeat2 size={13} /><span>循环</span>
        </button>
      </div>
      <div className="timeline-clock"><b>{currentTime.toFixed(2)}</b><span>秒 /</span>
        <NumberField label="总时长" value={clip.duration} unit="秒" minimum={0.5} maximum={120} step={0.1} disabled={disabled} commitOnBlur onChange={changeDuration} />
      </div>
      <button className="timeline-add" disabled={disabled} title="捕获当前形态、缩放和旋转；同一时刻已有帧时覆盖该帧" onClick={addFrame}><Plus size={13} />添加关键帧</button>
    </div>

    <div className="timeline-body">
      <div className="timeline-lanes">
        <div className="timeline-ruler"><span className="timeline-lane-label">秒</span><div className="timeline-ruler-track">
          <div className="timeline-ticks">{Array.from({ length: tickCount + 1 }, (_, index) => {
            const value = clip.duration * index / tickCount;
            return <span key={index} className="timeline-tick" style={{ left: `${index / tickCount * 100}%` }}>{Number(value.toFixed(2))}</span>;
          })}</div>
          <input className="timeline-scrub" type="range" aria-label="动画时间" aria-valuetext={`${currentTime.toFixed(2)} 秒`} min={0} max={clip.duration} step={0.01} value={currentTime} disabled={disabled} onChange={(event) => seek(Number(event.target.value))} />
        </div></div>
        {LANES.map((lane) => <div className={`timeline-lane ${lane.id}`} key={lane.id}>
          <span className="timeline-lane-label">{lane.label}</span>
          <div className="timeline-track" role="group" tabIndex={disabled ? -1 : 0} aria-label={`${lane.label}轨道时间定位`} aria-disabled={disabled}
            title="拖动定位时间；方向键微调，Home / End 跳到起止"
            onPointerDown={startTrackScrub} onPointerMove={(event) => { if (scrubPointer.current === event.pointerId) seekTrack(event); }}
            onPointerUp={finishTrackScrub} onPointerCancel={finishTrackScrub} onLostPointerCapture={() => { scrubPointer.current = null; }} onKeyDown={keyTrackScrub}>
            <span className="timeline-playhead" style={{ left: `${currentTime / clip.duration * 100}%` }} />
            {clip.keyframes.map((frame) => <button key={frame.id} className={`timeline-keyframe ${selected.id === frame.id ? 'is-selected' : ''}`}
              style={{ left: `${frame.time / clip.duration * 100}%` }} disabled={disabled}
              aria-label={`选中 ${Number(frame.time.toFixed(2))} 秒的${lane.label}关键帧`} aria-pressed={selected.id === frame.id}
              title={`${frame.time.toFixed(2)} 秒 · ${lane.id === 'scale' ? frame.scale.toFixed(2) + ' ×' : lane.id === 'rotation' ? frame.rotation.map((angle) => angle + '°').join(' / ') : frame.progress === 0 ? '聚合' : frame.progress === 1 ? '消散' : '过渡形态'}`} onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => { event.stopPropagation(); select(frame, lane.id); }}><i /></button>)}
          </div>
        </div>)}
      </div>

      <fieldset className="timeline-keyframe-editor" disabled={disabled} ref={editor}>
        <div className="timeline-editor-heading"><strong>选中关键帧</strong><span>{clip.keyframes.findIndex((frame) => frame.id === selected.id) + 1} / {clip.keyframes.length}</span>
          <label className="timeline-interpolation"><span>过渡</span><select aria-label="到下一帧的过渡" title="当前关键帧到下一帧的插值；保持在下一帧时跳到新姿态" value={selected.interpolation ?? 'smooth'} onChange={(event) => editFrame({ interpolation: event.target.value as AnimationInterpolation })}>
            <option value="smooth">平滑</option><option value="linear">线性</option><option value="hold">保持</option>
          </select></label>
          <button className="timeline-delete" aria-label="删除选中关键帧" title={clip.keyframes.length <= 1 ? '至少保留一个关键帧' : '删除选中关键帧'} disabled={disabled || clip.keyframes.length <= 1} onClick={deleteFrame}><Trash2 size={13} /></button>
        </div>
        <div className="timeline-fields" key={selected.id}>
          <NumberField label="关键帧时间" value={selected.time} unit="秒" minimum={0} maximum={clip.duration} step={0.01} commitOnBlur onChange={(next) => editFrame({ time: next })} />
          <NumberField label="缩放" value={selected.scale} unit="×" minimum={0.1} maximum={4} step={0.05} onChange={(next) => editFrame({ scale: next })} />
          {[0, 1, 2].map((axis) => <NumberField key={axis} label={`旋转 ${'XYZ'[axis]}`} value={selected.rotation[axis]} unit="°" minimum={-1080} maximum={1080} step={1}
            onChange={(next) => { const rotation: [number, number, number] = [...selected.rotation]; rotation[axis] = next; editFrame({ rotation }); }} />)}
          <label className="timeline-shape-field"><span>形态</span><input type="range" aria-label="关键帧形态" aria-valuetext={selected.progress === 0 ? '聚合' : selected.progress === 1 ? '消散' : '过渡'} min={0} max={1} step={0.01} value={selected.progress} onChange={(event) => editFrame({ progress: Number(event.target.value) })} /><small><span>聚合</span><span>消散</span></small></label>
        </div>
      </fieldset>
    </div>
    <p className={`timeline-hint ${message || (loop && !seam.continuous) ? 'has-warning' : ''}`} role="status">
      {message || (loop && !seam.continuous
        ? `循环首尾的${seam.mismatches.join('、')}不一致，回到开头会跳变；可调整首末帧或关闭循环。`
        : '点击菱形编辑对应轨道；定位和编辑会暂停。时间与总时长按回车确认，Esc 取消；三条轨道共用帧。')}
    </p>
  </section>;
}

export default TimelinePanel;
