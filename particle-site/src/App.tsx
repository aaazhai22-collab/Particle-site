import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, DragEvent } from 'react';
import { Activity, ArrowDownToLine, ArrowUpRight, AudioLines, Box, Camera, Check, ChevronDown, ChevronRight, Circle, CircleHelp, FileJson, Focus, Image, Layers3, LoaderCircle, Maximize2, MoveUpRight, Pause, Play, Plus, RotateCcw, RotateCw, Save, Settings2, Sparkles, Square, Upload, Waves, Wind, X } from 'lucide-react';
import { ParticleEngine, DEFAULT_PARAMS } from './ParticleEngine';
import type { ParticleParams, Effect, EngineState } from './ParticleEngine';
import { CanvasRecorder } from './CanvasRecorder';
import type { RecorderState } from './CanvasRecorder';
import type { RecordingResult } from './CanvasRecorder';
import { exportTimelineVideo, isHDVideoExportSupported, getExportBitrate } from './HDVideoExporter';
import { createSphereAsset, loadParticleAsset } from './assets';
import { loadExampleBlob } from './exampleFiles';
import { publicAssetUrl } from './publicAssetUrl';
import type { ParticleAsset } from './assets';
import { LatestImport } from './importQueue';
import { DEFAULT_CLIP, normalizeClip, sampleClip } from './animation';
import type { AnimationClip } from './animation';
import { TimelinePanel } from './TimelinePanel';
import { MAX_PARTICLES } from './particleLimits';
import { PETAL_CLIP, PETAL_PARAMS, PETAL_PRESET_NAME, DEFAULT_PETAL_TIMING, normalizePetalTiming, scalePetalTiming, getPetalStages, retimePetalClip, petalPhaseAt } from './petalPreset';
import type { PetalTiming } from './petalPreset';
import { WHITE_LILY_PRESET_NAME, WHITE_LILY_PARAMS, WHITE_LILY_CLIP, WHITE_LILY_TIMING } from './whiteLilyPreset';
import { STARDUST_PRESET_NAME, STARDUST_PARAMS, STARDUST_CLIP, STARDUST_TIMING } from './stardustPreset';

const EFFECTS = [
  { id:'radial' as Effect, name:'径向扩散', en:'RADIAL', icon:MoveUpRight, description:'从原形态向三维空间舒展' },
  { id:'noise' as Effect, name:'噪声漂浮', en:'NOISE', icon:Wind, description:'柔和、相互关联的云雾运动' },
  { id:'vortex' as Effect, name:'旋涡消散', en:'VORTEX', icon:RotateCw, description:'围绕指定轴展开与卷曲' },
  { id:'directional' as Effect, name:'定向吹散', en:'WIND', icon:ArrowUpRight, description:'沿风向拉开，保留局部扰动' },
  { id:'wave' as Effect, name:'波浪消散', en:'WAVE', icon:Waves, description:'从一侧向另一侧传播消散' },
  { id:'erosion' as Effect, name:'流场侵蚀', en:'FLOW FIELD', icon:AudioLines, description:'局部孔洞、拉丝与卷曲细流' },
];
const initialState:EngineState = { progress:0, running:true, mode:'loop', direction:1, time:0, fps:0, actualCount:30000, timelineTime:0, timelineDuration:6, timelineLoop:true, playbackSource:'timeline', adaptiveStatus:'等待真实渲染样本', adaptiveCeiling:300000, frameMsAvg:0, ambientCount:0, filamentCount:0 };
const initialRecord:RecorderState = { status:'idle', elapsed:0, bytes:0, result:null, error:null };
type AssetInfo = Pick<ParticleAsset,'name'|'kind'|'count'|'hasOriginalColors'|'notes'|'thumbnail'>;
type ImportState = { status:'idle'|'loading'|'error'; name:string; error:string };
type Settings = { version:2; effect:Effect; params:ParticleParams; clip:AnimationClip; petalTiming?:PetalTiming };
type SavedPreset = { name:string; settings:Settings };
const STORAGE_KEY='particle-studio-presets-v2';
const REFERENCE_CLIP:AnimationClip = {
  duration:12,
  keyframes:[
    {id:'ref-start',time:0,scale:1,rotation:[0,0,0],progress:0},
    {id:'ref-hold',time:1.8,scale:1,rotation:[0,0,0],progress:0},
    {id:'ref-flow',time:5,scale:1.05,rotation:[0,8,-4],progress:.64},
    {id:'ref-fade',time:6.8,scale:1.08,rotation:[0,12,-6],progress:1},
    {id:'ref-return',time:7.5,scale:1.08,rotation:[0,12,-6],progress:1},
    {id:'ref-restored',time:10.8,scale:1,rotation:[0,0,0],progress:0},
    {id:'ref-end',time:12,scale:1,rotation:[0,0,0],progress:0},
  ],
};
const LILY_CLIP:AnimationClip = {
  duration:12,
  keyframes:[
    {id:'lily-start',time:0,scale:1,rotation:[0,0,0],progress:0},
    {id:'lily-hold',time:2.2,scale:1,rotation:[0,10,0],progress:0},
    {id:'lily-flow',time:5,scale:1.04,rotation:[-3,24,-3],progress:.65},
    {id:'lily-fade',time:6.6,scale:1.06,rotation:[-4,32,-4],progress:1},
    {id:'lily-return',time:7.2,scale:1.06,rotation:[-4,32,-4],progress:1},
    {id:'lily-restored',time:10.4,scale:1,rotation:[0,0,0],progress:0},
    {id:'lily-end',time:12,scale:1,rotation:[0,0,0],progress:0},
  ],
};
const DING_CLIP:AnimationClip = {
  duration:16,
  keyframes:[
    {id:'ding-front',time:0,scale:1,rotation:[0,0,0],progress:0},
    {id:'ding-hold',time:3,scale:1,rotation:[0,0,0],progress:0},
    {id:'ding-turn',time:6,scale:1,rotation:[0,32,0],progress:0},
    {id:'ding-flow',time:9,scale:1.02,rotation:[0,38,0],progress:.65},
    {id:'ding-fade',time:10.8,scale:1.02,rotation:[0,38,0],progress:1},
    {id:'ding-return',time:11.6,scale:1.02,rotation:[0,38,0],progress:1},
    {id:'ding-restored',time:14,scale:1,rotation:[0,0,0],progress:0},
    {id:'ding-end',time:16,scale:1,rotation:[0,0,0],progress:0},
  ],
};
function download(blob:Blob, filename:string) {
  const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=filename;
  document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1500);
}
function formatTime(t:number) { return String(Math.floor(t/60)).padStart(2,'0')+':'+String(Math.floor(t%60)).padStart(2,'0'); }
function safeName(name:string) { return name.replace(/\.[^.]+$/,'').replace(/[^\w\u4e00-\u9fff-]/g,'_').slice(0,80)||'Project'; }

function Range({label,value,min,max,step=1,unit='',onChange,description,disabled=false}:{label:string;value:number;min:number;max:number;step?:number;unit?:string;onChange:(value:number)=>void;description?:string;disabled?:boolean}) {
  const decimals=step<1?(step<.1?2:1):0;
  const [draft,setDraft]=useState(String(Number(value.toFixed(decimals)))); const editing=useRef(false);
  useEffect(()=>{if(!editing.current)setDraft(String(Number(value.toFixed(decimals))));},[value,decimals]);
  return <div className={'range-control '+(disabled?'disabled':'')}><div className="range-label"><label title={description}>{label}</label><div className="number-wrap"><input disabled={disabled} aria-label={label+'数值'} title={'范围 '+min+'–'+max+' '+unit} type="number" min={min} max={max} step={step} value={draft} onFocus={()=>{editing.current=true;}} onChange={e=>{setDraft(e.target.value);const n=e.target.valueAsNumber;if(Number.isFinite(n)&&n>=min&&n<=max)onChange(n);}} onBlur={()=>{editing.current=false;const n=draft.trim()===''?value:Number(draft);const next=Number.isFinite(n)?Math.max(min,Math.min(max,n)):value;setDraft(String(Number(next.toFixed(decimals))));if(!disabled)onChange(next);}}/><span>{unit}</span></div></div><input disabled={disabled} aria-label={label} className="slider" type="range" min={min} max={max} step={step} value={value} style={{'--fill':((value-min)/(max-min)*100)+'%'} as CSSProperties} onChange={e=>{editing.current=false;onChange(Number(e.target.value));setDraft(e.target.value);}}/></div>;
}
function Toggle({label,on,onChange,disabled=false}:{label:string;on:boolean;onChange:()=>void;disabled?:boolean}) {
  return <div className="toggle-row"><span>{label}</span><button disabled={disabled} className={'switch '+(on?'on':'')} aria-label={label} role="switch" aria-checked={on} onClick={onChange}><i/></button></div>;
}

export default function App() {
  const stageRef=useRef<HTMLDivElement>(null), workspaceRef=useRef<HTMLDivElement>(null), fileRef=useRef<HTMLInputElement>(null), jsonRef=useRef<HTMLInputElement>(null);
  const engine=useRef<ParticleEngine|null>(null), recorder=useRef<CanvasRecorder|null>(null);
  const imports=useRef(new LatestImport()), countTimer=useRef<ReturnType<typeof setTimeout>|null>(null), priorRunning=useRef(false);
  const autoCeiling=useRef(DEFAULT_PARAMS.count);
  const exportAbort=useRef<AbortController|null>(null), exportResultRef=useRef<RecordingResult|null>(null);
  const [exportBusy,setExportBusy]=useState(false), [exportProgress,setExportProgress]=useState(0), [exportError,setExportError]=useState('');
  const [exportResult,setExportResult]=useState<RecordingResult|null>(null), [videoSource,setVideoSource]=useState<'export'|'record'>('record');
  const [resolution,setResolution]=useState<'1080'|'2160'>('1080'), [exportFps,setExportFps]=useState<30|60>(60);
  const [previewQuality,setPreviewQuality]=useState<'smooth'|'sharp'>('smooth'), [renderSize,setRenderSize]=useState({width:1920,height:1080});
  const [params,setParams]=useState<ParticleParams>({...DEFAULT_PARAMS}), [state,setState]=useState(initialState), [effect,setEffect]=useState<Effect>('radial');
  const [clip,setClip]=useState<AnimationClip>(()=>normalizeClip(DEFAULT_CLIP)), [asset,setAsset]=useState<AssetInfo>({name:'粒子球体',kind:'sphere',count:MAX_PARTICLES,hasOriginalColors:false,notes:[]});
  const [petalTiming,setPetalTiming]=useState<PetalTiming|null>(null);
  const [record,setRecord]=useState(initialRecord), [tab,setTab]=useState<'params'|'record'>('params');
  const [toast,setToast]=useState(''), [help,setHelp]=useState(false), [videoOpen,setVideoOpen]=useState(false), [presentation,setPresentation]=useState(false);
  const [importOpen,setImportOpen]=useState(false), [importState,setImportState]=useState<ImportState>({status:'idle',name:'',error:''}), [dragging,setDragging]=useState(false);
  const [quality,setQuality]=useState<'standard'|'high'>('high'), [supported,setSupported]=useState(false), [codec,setCodec]=useState(''), [engineError,setEngineError]=useState('');
  const [presetName,setPresetName]=useState(''), [saved,setSaved]=useState<SavedPreset[]>(()=>{try{const a=JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]');return Array.isArray(a)?a.filter(p=>typeof p.name==='string'&&p.settings).slice(0,30):[];}catch{return [];}});
  const realtimeRecording=['recording','paused','processing'].includes(record.status);
  const activeRecording=realtimeRecording||exportBusy, importBusy=importState.status==='loading';
  const engineReady=!!engine.current&&!engineError, playbackLocked=exportBusy||record.status==='paused'||record.status==='processing';
  const outputWidth=resolution==='2160'?3840:1920, outputHeight=resolution==='2160'?2160:1080;
  const videoResult=videoSource==='export'?exportResult:record.result;
  const notify=(message:string)=>setToast(message);
  useEffect(()=>{if(!toast)return;const t=setTimeout(()=>setToast(''),5000);return()=>clearTimeout(t);},[toast]);
  useEffect(()=>{
    if(!stageRef.current)return; imports.current=new LatestImport(); let alive=true; let instance:ParticleEngine;
    try {
      instance=new ParticleEngine(stageRef.current,s=>{if(alive){setState({...s});if(instance){setEffect(instance.effect);const size=instance.outputSize;setRenderSize(old=>old.width===size.width&&old.height===size.height?old:size);}}},msg=>{if(alive)setEngineError(msg);});
      engine.current=instance; instance.setTimeline(normalizeClip(DEFAULT_CLIP)); instance.setTimelineLoop(true); instance.setTimelinePlaying(true);
      const r=new CanvasRecorder(instance.canvas,s=>{if(alive){instance.setRecordingLocked(['recording','paused','processing'].includes(s.status));instance.setCaptureActive(s.status==='recording');if(!['recording','paused','processing'].includes(s.status))instance.setCaptureSize(null);setRecord({...s});if(recorder.current)setCodec(recorder.current.mimeType);if(s.status==='ready'){setVideoSource('record');setVideoOpen(true);}if(s.error)setToast(s.error);}},paused=>{if(paused){priorRunning.current=instance.state.running;instance.setRunning(false);}else{instance.setRunning(priorRunning.current);}});
      recorder.current=r; setSupported(r.supported); setCodec(r.mimeType);
      loadUploadedDemo();
    } catch(error) { setEngineError('预览初始化失败：'+(error instanceof Error?error.message:'请使用支持 WebGL 的桌面浏览器。')); }
    return()=>{alive=false;exportAbort.current?.abort();if(exportResultRef.current)URL.revokeObjectURL(exportResultRef.current.url);imports.current.dispose();if(countTimer.current)clearTimeout(countTimer.current);recorder.current?.destroy();engine.current?.destroy();};
  },[]);
  useEffect(()=>{const handler=()=>{if(!document.fullscreenElement)setPresentation(false);};document.addEventListener('fullscreenchange',handler);return()=>document.removeEventListener('fullscreenchange',handler);},[]);
  useEffect(()=>{
    const key=(e:KeyboardEvent)=>{
      if(exportBusy)return;
      if(e.key==='Escape'){setHelp(false);setImportOpen(false);setVideoOpen(false);setPresentation(false);return;}
      if(e.ctrlKey||e.metaKey||e.altKey)return;
      if((e.target as HTMLElement)?.closest('input:not([type="range"]),textarea,select,[contenteditable="true"]'))return;
      if(help||videoOpen||importOpen)return;
      if(e.code==='Space'&&(e.target as HTMLElement)?.closest('button'))return;
      if(e.code==='Space'){e.preventDefault();if(!playbackLocked&&!e.repeat)engine.current?.togglePause();}
      if(e.key.toLowerCase()==='r')engine.current?.resetView();
    };
    window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
  },[help,videoOpen,importOpen,playbackLocked,exportBusy]);
  const change=<K extends keyof ParticleParams>(key:K,value:ParticleParams[K])=>{
    const locked=['recording','paused','processing'].includes(recorder.current?.state.status??record.status);
    if(locked&&(key==='resolution'||(key==='count'&&params.autoCount)))return;
    setParams(p=>({...p,[key]:value}));
    if(key==='count'){if(params.autoCount)autoCeiling.current=value as number;if(countTimer.current)clearTimeout(countTimer.current);countTimer.current=setTimeout(()=>{countTimer.current=null;engine.current?.setParams({count:value as number});},180);}
    else engine.current?.setParams({[key]:value});
  };
  const applyParameterPatch=(incoming:Partial<ParticleParams>)=>{
    const current=engine.current?.params??params,patch={...incoming};
    if(countTimer.current){clearTimeout(countTimer.current);countTimer.current=null;if(patch.count===undefined)patch.count=params.count;}
    const latestRecordStatus=recorder.current?.state.status??record.status;
    if(['recording','paused','processing'].includes(latestRecordStatus)){patch.autoCount=current.autoCount;patch.resolution=current.resolution;if(current.autoCount)patch.count=current.count;}
    engine.current?.setParams(patch);
    const next=engine.current?.params??{...params,...patch};
    if(next.autoCount)autoCeiling.current=next.count;
    setParams(next);return next;
  };
  const changeCountMode=(automatic:boolean)=>{
    if(activeRecording||automatic===params.autoCount)return;
    if(countTimer.current){clearTimeout(countTimer.current);countTimer.current=null;}
    if(params.autoCount)autoCeiling.current=params.count;
    const count=automatic?autoCeiling.current:Math.max(1000,engine.current?.state.actualCount??state.actualCount);
    const patch={autoCount:automatic,count};setParams(p=>({...p,...patch}));engine.current?.setParams(patch);
  };
  const changeClip=(next:AnimationClip)=>{const normalized=normalizeClip(next);if(petalTiming&&Math.abs(normalized.duration-clip.duration)>1e-7)setPetalTiming(scalePetalTiming(petalTiming,normalized.duration));setClip(normalized);engine.current?.setTimeline(normalized);engine.current?.seekTimeline(state.timelineTime);};
  const changePetalDuration=(key:'disperse'|'assemble',value:number)=>{
    if(!petalTiming||playbackLocked)return;
    const nextTiming=normalizePetalTiming({...petalTiming,[key]:value});
    const nextClip=retimePetalClip(clip,petalTiming,nextTiming);
    setPetalTiming(nextTiming);setClip(nextClip);engine.current?.setTimeline(nextClip);engine.current?.seekTimeline(Math.min(state.timelineTime,nextClip.duration));
  };
  const applyPetalPreset=()=>{
    if(playbackLocked)return;
    applyParameterPatch({...PETAL_PARAMS,colorMode:asset.hasOriginalColors?'original':'uniform'});
    const nextClip=normalizeClip(PETAL_CLIP),e=engine.current;
    setPetalTiming({...DEFAULT_PETAL_TIMING});setClip(nextClip);setEffect('erosion');
    e?.setTimeline(nextClip);e?.seekTimeline(0);e?.setEffect('erosion');e?.setTimelineLoop(true);e?.setTimelinePlaying(true);
    notify('已应用「'+PETAL_PRESET_NAME+'」，保留当前素材；空格暂停 / 播放。');
  };
  const applyWhiteLilyPreset=()=>{
    if(playbackLocked)return;
    applyParameterPatch({...WHITE_LILY_PARAMS,colorMode:asset.hasOriginalColors?'original':'uniform'});
    const nextClip=normalizeClip(WHITE_LILY_CLIP),e=engine.current;
    setPetalTiming({...WHITE_LILY_TIMING});setClip(nextClip);setEffect('erosion');
    e?.setTimeline(nextClip);e?.seekTimeline(0);e?.setEffect('erosion');e?.setTimelineLoop(true);e?.setTimelinePlaying(true);
    notify('已应用「'+WHITE_LILY_PRESET_NAME+'」，保留当前素材；空格暂停 / 播放。');
  };
  const applyStardustPreset=()=>{
    if(playbackLocked)return;
    applyParameterPatch({...STARDUST_PARAMS,colorMode:asset.hasOriginalColors?'original':'uniform'});
    const nextClip=normalizeClip(STARDUST_CLIP),e=engine.current;
    setPetalTiming({...STARDUST_TIMING});setClip(nextClip);setEffect('erosion');
    e?.setTimeline(nextClip);e?.seekTimeline(0);e?.setEffect('erosion');e?.setTimelineLoop(true);e?.setTimelinePlaying(true);
    notify('已应用「'+STARDUST_PRESET_NAME+'」，保留当前素材与视角；空格暂停 / 播放。');
  };
  const reset=(keys:(keyof ParticleParams)[])=>{
    const patch:Partial<ParticleParams>={};keys.forEach(key=>Object.assign(patch,{[key]:DEFAULT_PARAMS[key]}));applyParameterPatch(patch);
  };
  const switchEffect=(next:Effect)=>{
    if(playbackLocked)return;engine.current?.setEffect(next);
    if(state.progress>.001)notify('正在聚合，随后应用新效果。按空格播放时间轴。');else setEffect(next);
  };
  const applyPreset=(name:string)=>{
    if(playbackLocked)return;if(name===STARDUST_PRESET_NAME){applyStardustPreset();return;}if(name===WHITE_LILY_PRESET_NAME){applyWhiteLilyPreset();return;}if(name===PETAL_PRESET_NAME){applyPetalPreset();return;}let patch:Partial<ParticleParams>,next:Effect;
    if(name==='柔和漂浮'){next='noise';patch={spread:1.25,depth:.9,scatter:.18,stagger:.3,turbulence:.23,motionSpeed:.5,duration:6,size:1.6,glow:.6,exposure:1.3,contrast:.9,curl:.8,sparkle:.18,fade:false,trail:.2};}
    else if(name==='能量爆散'){next='radial';patch={spread:3,depth:1.7,scatter:.7,stagger:.15,turbulence:.18,motionSpeed:1.4,duration:2,size:1.7,glow:1.15,exposure:1.55,contrast:1.15,curl:1.3,sparkle:.7,fade:false,trail:.5};}
    else if(name==='旋涡聚合'){next='vortex';patch={spread:1.6,depth:1.2,scatter:.2,stagger:.35,turbulence:.12,motionSpeed:.8,duration:4,size:1.6,glow:.7,exposure:1.4,contrast:1.05,curl:1.6,sparkle:.3,axis:'y',fade:false,trail:.55};}
    else if(name==='深空漂移'){next='noise';patch={spread:1.6,depth:2.5,scatter:.5,stagger:.25,turbulence:.35,motionSpeed:.4,size:1.3,glow:.8,exposure:1.5,contrast:1.2,curl:1.1,sparkle:.65,fade:false,trail:.3};}
    else if(name==='错峰卷流'){next='erosion';patch={spread:1.25,depth:1.4,scatter:.15,stagger:.8,turbulence:.2,motionSpeed:.65,erosion:.85,flowScale:1.2,stringiness:2.4,curl:2.1,glow:.7,exposure:1.5,contrast:1.05,sparkle:.3,trail:.7,fade:false,direction:'x'};}
    else{next='erosion';patch={autoCount:true,count:300000,spread:1.15,depth:1.35,scatter:.18,stagger:.5,turbulence:.18,motionSpeed:.55,size:1.7,opacity:.95,glow:.7,exposure:1.55,contrast:1.05,curl:1.8,sparkle:.35,erosion:.72,flowScale:1.2,stringiness:2.2,trail:.65,fade:true,colorMode:asset.hasOriginalColors?'original':'uniform',direction:'y'};}
    setPetalTiming(null);applyParameterPatch({surfaceMode:false,petalFlow:false,grainStyle:false,...patch});switchEffect(next);notify('已应用「'+name+'」。按空格预览动画。');
  };
  const runImport=(name:string,load:()=>Promise<ParticleAsset>,afterLoad?:()=>void)=>{
    if(activeRecording){notify('录制结束后可替换素材。');return;}
    setImportState({status:'loading',name,error:''});
    void imports.current.run(load,{
      success:next=>{
        try {
          if(!engine.current)throw new Error('粒子预览尚未准备好，请刷新后重试。');
          engine.current.setAsset(next);engine.current.resetView();
          const mode=next.hasOriginalColors?'original':'uniform';engine.current.setParams({colorMode:mode});setParams(p=>({...p,colorMode:mode}));
          setAsset({name:next.name,kind:next.kind,count:next.count,hasOriginalColors:next.hasOriginalColors,notes:next.notes,thumbnail:next.thumbnail});
          setImportState({status:'idle',name:'',error:''});setImportOpen(false);setDragging(false);notify('已载入「'+next.name+'」，'+engine.current.state.actualCount.toLocaleString()+' 个粒子。');afterLoad?.();
        } catch(error) { setImportState({status:'error',name,error:error instanceof Error?error.message:'素材处理失败，请重试。'}); }
      },
      failure:error=>{setImportState({status:'error',name,error:error instanceof Error?error.message:'读取素材失败，请重新选择文件。'});setDragging(false);setImportOpen(true);},
    });
  };
  const chooseFiles=(files:FileList|null)=>{if(!files?.length)return;const file=files[files.length-1];runImport(file.name,()=>loadParticleAsset(file));};
  const example=(url:string,name:string)=>runImport(name,async()=>{const blob=await loadExampleBlob(url,'示例素材读取失败，请稍后重试。');return loadParticleAsset(new File([blob],name));});
  const loadUploadedDemo=()=>runImport('百合花束.glb',async()=>{
    const blob=await loadExampleBlob(publicAssetUrl('/examples/uploaded-model.glb'),'百合花束读取失败，请重试或导入你提供的原始 GLB。');
    const next=await loadParticleAsset(new File([blob],'百合花束.glb',{type:'model/gltf-binary'}));
    return {...next,thumbnail:publicAssetUrl('/examples/uploaded-model-preview.jpg'),notes:['来自你提供的 GLB · 双朵百合与完整茎叶。','原色三维粒子 · 可旋转观察与编辑动画。',...next.notes]};
  },()=>{
    const e=engine.current;if(!e)return;
    if(countTimer.current){clearTimeout(countTimer.current);countTimer.current=null;}
    e.setParams({...WHITE_LILY_PARAMS,petalFlow:false,grainStyle:false,colorMode:'original',autoCount:true,count:300000,glow:.18,trail:.12,sparkle:.02,exposure:1.25});
    autoCeiling.current=e.params.count;setParams(e.params);setPetalTiming({...WHITE_LILY_TIMING});
    e.setTimeline(WHITE_LILY_CLIP);e.seekTimeline(0);e.setEffect('erosion');e.fitView('full');e.setTimelineLoop(true);e.setTimelinePlaying(true);
    setEffect('erosion');setClip(normalizeClip(WHITE_LILY_CLIP));notify('你的百合花束已载入：原色三维展示，36 秒聚散循环。');
  });
  const loadWhiteLilyDemo=()=>runImport('白百合自然风蚀示例.glb',async()=>{
    const blob=await loadExampleBlob(publicAssetUrl('/examples/white-lily-model.glb'),'白百合模型暂时无法读取，当前场景已保留，请重试或导入本地 GLB。');
    const next=await loadParticleAsset(new File([blob],'白百合自然风蚀示例.glb',{type:'model/gltf-binary'}));
    return {...next,thumbnail:publicAssetUrl('/examples/white-lily-preview-front.png'),notes:[
      '参考照片制作的立体近似；背面与遮挡部分为补建。',
      '白色花瓣、淡绿花心与棕色花药 · 自然风蚀与渐隐回环。',
      ...next.notes,
    ]};
  },()=>{
    const e=engine.current;if(!e)return;
    if(countTimer.current){clearTimeout(countTimer.current);countTimer.current=null;}
    e.setParams({...WHITE_LILY_PARAMS,colorMode:'original'});autoCeiling.current=e.params.count;setParams(e.params);
    e.setTimeline(WHITE_LILY_CLIP);e.seekTimeline(0);e.setEffect('erosion');e.fitView('full');e.setTimelineLoop(true);e.setTimelinePlaying(true);
    setPetalTiming({...WHITE_LILY_TIMING});setEffect('erosion');setClip(normalizeClip(WHITE_LILY_CLIP));
    notify('白百合已就绪：参考照片的立体近似，36 秒自然风蚀回环；数量按设备自动调整。');
  });
  const loadPetalDemo=(referenceLook=false)=>runImport('花瓣微流示例.glb',async()=>{
    const blob=await loadExampleBlob(publicAssetUrl('/examples/petal-model.glb'),'花瓣模型暂时无法读取，当前场景已保留，请重试或导入本地 GLB。');
    const next=await loadParticleAsset(new File([blob],'花瓣微流示例.glb',{type:'model/gltf-binary'}));
    return {...next,thumbnail:publicAssetUrl('/examples/petal-preview-front.png'),notes:[
      '粉色花瓣、橙黄花心 · 独立三维曲面。',
      '36 秒渐隐回环 · 主体、外围微流与细丝分层。',
      ...next.notes,
    ]};
  },()=>{
    const e=engine.current;if(!e)return;
    if(countTimer.current){clearTimeout(countTimer.current);countTimer.current=null;}
    const look=referenceLook?STARDUST_PARAMS:PETAL_PARAMS,nextClip=referenceLook?STARDUST_CLIP:PETAL_CLIP;
    e.setParams({...look,colorMode:'original'});autoCeiling.current=e.params.count;setParams(e.params);
    e.setTimeline(nextClip);e.seekTimeline(0);e.setEffect('erosion');e.fitView(referenceLook?'macro':'full');e.setTimelineLoop(true);e.setTimelinePlaying(true);
    setPetalTiming({...DEFAULT_PETAL_TIMING});setEffect('erosion');setClip(normalizeClip(nextClip));
    notify(referenceLook?'繁花星尘已就绪：粉色花瓣、黄色花蕊，36 秒晶亮颗粒渐蚀回环。':'花瓣微流已就绪：36 秒回环，1080p 真实画布；数量按设备自动调整。');
  });
  const loadDingDemo=()=>runImport('青铜方鼎.glb',async()=>{
    const blob=await loadExampleBlob(publicAssetUrl('/examples/ding-model.glb'),'青铜方鼎读取失败，请重试或下载后导入 GLB。');
    const next=await loadParticleAsset(new File([blob],'青铜方鼎.glb',{type:'model/gltf-binary'}));
    return {...next,thumbnail:publicAssetUrl('/examples/ding-reference.jpg'),notes:[
      '双耳、器身与四足 · 完整三维表面。',
      '青铜原色 · 拖动观察，空格暂停 / 播放。',
      ...next.notes,
    ]};
  },()=>{
    const e=engine.current;if(!e)return;
    if(countTimer.current){clearTimeout(countTimer.current);countTimer.current=null;}
    setPetalTiming(null);e.setParams({surfaceMode:false,petalFlow:false,grainStyle:false,autoCount:true,count:300000,colorMode:'original',size:1.7,opacity:.95,glow:.65,exposure:1.45,contrast:1.1,curl:1.5,sparkle:.28,spread:1.1,depth:1.15,scatter:.2,stagger:.6,turbulence:.12,motionSpeed:.6,playbackRate:1,erosion:.68,flowScale:1.25,stringiness:2,trail:.55,fade:true,direction:'y',autoRotate:false});
    autoCeiling.current=e.params.count;setParams(e.params);e.setTimeline(DING_CLIP);e.seekTimeline(0);e.setEffect('erosion');e.fitView();e.setTimelineLoop(true);e.setTimelinePlaying(true);
    setEffect('erosion');setClip(normalizeClip(DING_CLIP));notify('青铜方鼎已就绪：16 秒循环展示，空格暂停，拖动观察三维细节。');
  });
  const loadReferenceDemo=()=>runImport('粒子花朵参考.jpg',async()=>{
    const blob=await loadExampleBlob(publicAssetUrl('/examples/particle-flower-reference.jpg'),'参考图片读取失败，请重新选择文件。');
    return loadParticleAsset(new File([blob],'粒子花朵参考.jpg',{type:'image/jpeg'}));
  },()=>{
    const e=engine.current;if(!e)return;
    const patch:Partial<ParticleParams>={autoCount:true,count:300000,colorMode:'original',size:1.7,opacity:.95,glow:.7,exposure:1.55,contrast:1.05,curl:1.8,sparkle:.35,spread:1.15,depth:1.35,scatter:.18,stagger:.5,turbulence:.18,motionSpeed:.55,playbackRate:1,erosion:.72,flowScale:1.2,stringiness:2.2,trail:.65,fade:true,direction:'y',autoRotate:false};
    if(countTimer.current){clearTimeout(countTimer.current);countTimer.current=null;}
    setPetalTiming(null);e.setParams({surfaceMode:false,petalFlow:false,grainStyle:false,...patch});autoCeiling.current=e.params.count;setParams(e.params);e.setTimeline(REFERENCE_CLIP);e.seekTimeline(0);e.setEffect('erosion');e.fitView();e.setTimelineLoop(true);e.setTimelinePlaying(true);
    setEffect('erosion');setClip(normalizeClip(REFERENCE_CLIP));notify('已开启你的参考图展示：12 秒关键帧循环，空格暂停 / 播放。');
  });
  const loadLilyDemo=()=>runImport('彩色百合立体示例.glb',async()=>{
    const blob=await loadExampleBlob(publicAssetUrl('/examples/lily-model.glb'),'百合模型读取失败，请重试或导入本地 GLB。');
    const next=await loadParticleAsset(new File([blob],'彩色百合立体示例.glb',{type:'model/gltf-binary'}));
    return {...next,thumbnail:publicAssetUrl('/examples/lily-reference.jpg'),notes:[
      '参考照片制作的立体近似；背面与遮挡部分为补建。',
      '原图配色 · 独立花瓣、花蕊、花茎与叶片。',
      ...next.notes,
    ]};
  },()=>{
    const e=engine.current;if(!e)return;
    if(countTimer.current){clearTimeout(countTimer.current);countTimer.current=null;}
    setPetalTiming(null);e.setParams({surfaceMode:false,petalFlow:false,grainStyle:false,autoCount:true,count:300000,colorMode:'original',size:1.7,opacity:.95,glow:.7,exposure:1.55,contrast:1.05,curl:1.8,sparkle:.3,spread:1.1,depth:1.3,scatter:.18,stagger:.5,turbulence:.18,motionSpeed:.6,playbackRate:1,erosion:.72,flowScale:1.25,stringiness:2.2,trail:.65,fade:true,direction:'y',autoRotate:false});
    autoCeiling.current=e.params.count;setParams(e.params);e.setTimeline(LILY_CLIP);e.seekTimeline(0);e.setEffect('erosion');e.fitView();e.setTimelineLoop(true);e.setTimelinePlaying(true);
    setEffect('erosion');setClip(normalizeClip(LILY_CLIP));notify('已开启彩色百合 3D 展示：12 秒循环，空格暂停；拖动画面观察侧面。');
  });
  const dropFiles=(e:DragEvent)=>{e.preventDefault();e.stopPropagation();setDragging(false);chooseFiles(e.dataTransfer.files);};
  const currentSettings=():Settings=>({version:2,effect,params:{...params},clip:normalizeClip(clip),...(petalTiming?{petalTiming:{...petalTiming}}:{})});
  const applySettings=(input:unknown)=>{
    const latestRecordStatus=recorder.current?.state.status??record.status;
    if(latestRecordStatus==='paused'||latestRecordStatus==='processing')throw new Error('录制暂停或视频生成期间无法导入动画参数，请继续或完成录制后重试。');
    if(!input||typeof input!=='object')throw new Error('参数文件不是有效的 JSON 对象。');
    const data=input as Record<string,unknown>;
    if(!EFFECTS.some(e=>e.id===data.effect)||!data.params||typeof data.params!=='object')throw new Error('文件缺少有效的粒子效果或参数。');
    const raw=data.params as Record<string,unknown>,patch:ParticleParams={...DEFAULT_PARAMS};
    for(const key of Object.keys(DEFAULT_PARAMS) as (keyof ParticleParams)[]){const value=raw[key];if(value!==undefined&&typeof value===typeof DEFAULT_PARAMS[key]&&(typeof value!=='number'||Number.isFinite(value)))Object.assign(patch,{[key]:value});}
    if(!/^#[0-9a-f]{6}$/i.test(patch.color))patch.color=DEFAULT_PARAMS.color;
    if(!['original','uniform'].includes(patch.colorMode))patch.colorMode=DEFAULT_PARAMS.colorMode;
    if(!['x','y','z'].includes(patch.axis))patch.axis=DEFAULT_PARAMS.axis;
    if(!['x','-x','y','-y','z','-z'].includes(patch.direction))patch.direction=DEFAULT_PARAMS.direction;
    if(!['720p','1080p'].includes(patch.resolution))patch.resolution=DEFAULT_PARAMS.resolution;
    if(!asset.hasOriginalColors&&patch.colorMode==='original')patch.colorMode='uniform';
    const nextClip=data.clip?normalizeClip(data.clip):normalizeClip(DEFAULT_CLIP);
    const restored=applyParameterPatch(patch);autoCeiling.current=restored.autoCount?restored.count:DEFAULT_PARAMS.count;
    setPetalTiming(data.petalTiming&&typeof data.petalTiming==='object'&&!Array.isArray(data.petalTiming)?scalePetalTiming(normalizePetalTiming(data.petalTiming),nextClip.duration):null);
    engine.current?.setTimeline(nextClip);engine.current?.seekTimeline(0);engine.current?.setEffect(data.effect as Effect);setEffect(data.effect as Effect);setClip(nextClip);
    notify('参数和关键帧已恢复。按空格播放。');
  };
  const importSettings=async(file:File)=>{try{if(file.size>1024*1024)throw new Error('参数 JSON 请小于 1 MB。');applySettings(JSON.parse(await file.text()));}catch(error){notify('参数导入失败：'+(error instanceof Error?error.message:'文件无法读取。'));}};
  const savePreset=()=>{
    const name=presetName.trim();if(!name){notify('请先输入预设名称。');return;}
    const next=[...saved.filter(p=>p.name!==name),{name,settings:currentSettings()}].slice(-30);
    try{localStorage.setItem(STORAGE_KEY,JSON.stringify(next));setSaved(next);setPresetName('');notify('已保存「'+name+'」，包含效果、参数和关键帧。');}catch{notify('浏览器本地存储不可用，请导出 JSON 保存。');}
  };
  const screenshot=async()=>{try{const e=engine.current,width=e?.canvas.width,height=e?.canvas.height,blob=await e?.screenshot();if(blob){download(blob,'Particle_'+safeName(asset.name)+'_'+Date.now()+'.png');notify('已导出 '+width+' × '+height+' PNG。');}}catch{notify('截图失败，请稍后重试。');}};
  const startRealtimeRecording=()=>{
    if(activeRecording)return;
    if(countTimer.current){clearTimeout(countTimer.current);countTimer.current=null;engine.current?.setParams({count:params.count});}
    engine.current?.setCaptureSize(1920,1080);recorder.current?.setProjectName(asset.name);recorder.current?.start(quality,{width:1920,height:1080,fps:60});
  };
  const startHDExport=async()=>{
    const e=engine.current;if(!e||activeRecording||importBusy||exportAbort.current)return;
    if(countTimer.current){clearTimeout(countTimer.current);countTimer.current=null;}e.setParams({count:params.count});
    const controller=new AbortController();exportAbort.current=controller;setExportBusy(true);setExportProgress(0);setExportError('');
    try{
      if(!isHDVideoExportSupported())throw new Error('当前浏览器不支持高清逐帧导出，请使用最新版 Chrome 或 Edge。');
      const result=await exportTimelineVideo(e.beginOfflineExport(outputWidth,outputHeight,exportFps),{width:outputWidth,height:outputHeight,fps:exportFps,quality,projectName:asset.name,signal:controller.signal},setExportProgress);
      if(controller.signal.aborted){URL.revokeObjectURL(result.url);return;}
      if(exportResultRef.current)URL.revokeObjectURL(exportResultRef.current.url);
      exportResultRef.current=result;setExportResult(result);setVideoSource('export');setVideoOpen(true);notify('高清视频已生成，可预览和下载。');
    }catch(error){if(!controller.signal.aborted)setExportError(error instanceof Error?error.message:'视频导出失败，请重试。');}
    finally{exportAbort.current=null;setExportBusy(false);}
  };
  const downloadVideo=(result:RecordingResult)=>download(result.blob,result.filename);
  const fullscreen=async()=>{if(presentation){if(document.fullscreenElement)await document.exitFullscreen();setPresentation(false);}else{setPresentation(true);try{await workspaceRef.current?.requestFullscreen();}catch{notify('已切换展示布局，按 Esc 退出。');}}};
  const current=EFFECTS.find(item=>item.id===effect)??EFFECTS[0];
  const currentSample=engine.current?.currentSample??{...sampleClip(clip,state.timelineTime),progress:state.progress};
  const outputSize=params.resolution==='1080p'?'1920 × 1080':'1280 × 720';
  const petalStages=petalTiming?getPetalStages(petalTiming):null;

  return <div className={'app '+(presentation?'presentation':'')+(petalTiming?' petal-workspace':'')} ref={workspaceRef} onDragOver={e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault();}} onDrop={e=>{if(exportBusy){e.preventDefault();return;}if(e.dataTransfer.files.length){setImportOpen(true);dropFiles(e);}}}>
    <input ref={fileRef} type="file" className="hidden-file" aria-label="选择素材文件" accept=".png,.jpg,.jpeg,.glb" onChange={e=>{chooseFiles(e.target.files);e.target.value='';}}/>
    <input ref={jsonRef} type="file" className="hidden-file" aria-label="选择参数文件" accept=".json,application/json" onChange={e=>{const file=e.target.files?.[0];if(file)void importSettings(file);e.target.value='';}}/>
    <header className="topbar" inert={exportBusy}>
      <a className="brand" href="#" onClick={e=>e.preventDefault()}><span className="brand-mark"><Sparkles size={21}/></span><span>粒子工坊<small>PARTICLE STUDIO</small></span></a>
      <div className="project-name"><span className="project-dot"/><span className="project-file" title={asset.name}>{asset.name}</span><span className="project-separator">/</span><span className="muted">粒子动画工作台</span><span className="version">V0.6</span></div>
      <div className="header-actions"><span className="local-tag"><span/>本地处理</span><button className="icon-button" title="操作说明" aria-label="操作说明" onClick={()=>setHelp(true)}><CircleHelp size={19}/></button><button className="secondary small" disabled={playbackLocked} onClick={()=>jsonRef.current?.click()}><Upload size={14}/>导入参数</button><button className="secondary small" onClick={()=>download(new Blob([JSON.stringify(currentSettings(),null,2)],{type:'application/json'}),'Particle_'+safeName(asset.name)+'_animation.json')}><FileJson size={15}/>导出项目</button></div>
    </header>
    <aside className="left-panel" inert={exportBusy}><div className="panel-heading"><Layers3 size={16}/><span>素材与效果</span><span className="section-index">01</span></div><div className="side-content">
      <div className="eyebrow">当前素材 <span className="mini-status">{asset.kind==='sphere'?'内置':asset.kind==='image'?'图片':'3D 模型'}</span></div>
      <button className="source-card import-source" disabled={activeRecording} onClick={()=>setImportOpen(true)} aria-label="打开素材导入窗口">
        {asset.thumbnail?<div className="asset-thumbnail"><img src={asset.thumbnail} alt="当前素材缩略图"/><span><Upload size={14}/>替换素材</span></div>:<div className="sphere-thumb"><div/><span className="thumb-axis">Y<br/>└ X</span><span className="import-hover"><Upload size={15}/>导入素材</span></div>}
        <div className="source-info"><div>{asset.kind==='image'?<Image size={15}/>:<Box size={15}/>}<strong title={asset.name}>{asset.name}</strong><span className="source-check"><Check size={12}/></span></div><p>{asset.kind==='image'?'IMAGE · 颜色像素采样':asset.kind==='model'?'GLB · 多网格表面采样':'SPHERE · 三维表面采样'}</p></div>
      </button>
      <button className="import-button" disabled={activeRecording||!engineReady} onClick={()=>setImportOpen(true)}>{importBusy?<LoaderCircle className="spin" size={15}/>:<Plus size={15}/>} {importBusy?'正在处理素材':'导入图片 / 3D 模型'}<span>PNG · JPG · GLB</span></button>
      <button className="petal-demo-button uploaded-demo-button" disabled={activeRecording||importBusy||!engineReady} onClick={loadUploadedDemo}><Box size={14}/><span>你的百合花束<small>导入文件预设 / 原色三维 / 36 秒回环</small></span><Play size={12}/></button>
      <button className="petal-demo-button" disabled={activeRecording||importBusy||!engineReady} onClick={loadWhiteLilyDemo}><Wind size={14}/><span>白百合 · 自然风蚀<small>参考照片的立体近似 / 36 秒回环</small></span><Play size={12}/></button>
      <button className="petal-demo-button" disabled={activeRecording||importBusy||!engineReady} onClick={()=>loadPetalDemo()}><Sparkles size={14}/><span>花瓣微流 · 立体花朵<small>原色 / 1080p / 36 秒回环</small></span><Play size={12}/></button>
      <button className="ding-demo-button" disabled={activeRecording||importBusy||!engineReady} onClick={loadDingDemo}><Box size={14}/>青铜方鼎展示<Play size={12}/></button>
      <div className="source-meta"><span>主体粒子</span><b>{state.actualCount.toLocaleString()} <small>个</small></b></div>
      {asset.count<params.count&&<p className="stage-note">素材有效采样上限为 {asset.count.toLocaleString()} 个粒子。</p>}
      {asset.notes.length>0&&<div className="asset-notes">{asset.notes.map((note,i)=><p key={i}>{note}</p>)}</div>}
      {importBusy&&<p className="stage-note">正在载入 {importState.name}；原画面仍可使用。</p>}
      <div className="divider"/><div className="section-title"><span>粒子变化</span><span className="count-label">06</span></div>
      <div className="effect-list">{EFFECTS.map(item=><button key={item.id} title={item.description} className={'effect-card '+(effect===item.id?'selected':'')} onClick={()=>switchEffect(item.id)} disabled={!engineReady||playbackLocked}><span className={'effect-art '+item.id}><item.icon size={22}/></span><span className="effect-info"><strong>{item.name}</strong><small>{item.en}</small></span><span className="effect-radio">{effect===item.id&&<i/>}</span></button>)}</div>
      <div className="divider"/><div className="section-title"><span>视觉预设</span><Sparkles size={13}/></div>
      <div className="preset-list">{[STARDUST_PRESET_NAME,WHITE_LILY_PRESET_NAME,PETAL_PRESET_NAME,'柔和漂浮','能量爆散','旋涡聚合','深空漂移','错峰卷流','参考视频风格'].map((p,i)=><button disabled={!engineReady||playbackLocked} key={p} onClick={()=>applyPreset(p)}><span className={'preset-dot dot-'+(i%4)}/>{p}<ArrowUpRight size={13}/></button>)}</div>
      <button className="secondary stardust-demo" disabled={!engineReady||playbackLocked||activeRecording||importBusy} onClick={()=>loadPetalDemo(true)}><Sparkles size={14}/><span>粉色花朵参考演示<small>晶亮颗粒 · 局部孔洞 · 卷曲渐隐</small></span><ArrowUpRight size={13}/></button>
      <p className="control-hint">视觉预设保留当前素材；参考演示会载入粉色立体花朵。</p>
      <div className="save-preset"><input aria-label="预设名称" placeholder="给这组效果命名" value={presetName} maxLength={40} onChange={e=>setPresetName(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')savePreset();}}/><button title="保存当前预设" aria-label="保存当前预设" onClick={savePreset}><Save size={14}/></button></div>
      {saved.length>0&&<select aria-label="载入已保存预设" value="" disabled={playbackLocked} onChange={e=>{const p=saved[Number(e.target.value)];if(p)try{applySettings(p.settings);}catch{notify('这个预设已失效，请重新保存。');}}}><option value="">载入已保存预设…</option>{saved.map((p,i)=><option key={p.name} value={i}>{p.name}</option>)}</select>}
      <div className="left-bottom"><div className="lab-label"><Activity size={14}/>素材 · 流场 · 关键帧</div><button className="text-link" onClick={()=>setHelp(true)}>查看操作指南 <ChevronRight size={13}/></button></div>
    </div></aside>
    <main className="preview" inert={exportBusy}><div className="preview-top"><div><span className="live-dot"/>实时预览 <span className="preview-sub">/ {current.name}</span></div><div className="composition-switch"><button aria-label="完整构图" title="让完整主体进入画面" onClick={()=>engine.current?.fitView('full')}>完整构图</button><button aria-label="细节特写" title="放大主体表面，观察细密粒子" onClick={()=>engine.current?.fitView('macro')}>细节特写</button></div><div className="preview-quality" role="group" aria-label="预览清晰度"><button disabled={activeRecording} className={previewQuality==='smooth'?'active':''} onClick={()=>{setPreviewQuality('smooth');engine.current?.setPreviewQuality('smooth');}}>流畅</button><button disabled={activeRecording} className={previewQuality==='sharp'?'active':''} onClick={()=>{setPreviewQuality('sharp');engine.current?.setPreviewQuality('sharp');}}>高清</button></div></div>
      <div className="canvas-area"><div className="canvas-mount" ref={stageRef}/>{engineError&&<div className="engine-error"><strong>无法启动粒子预览</strong><p>{engineError}</p><p>请开启浏览器硬件加速后刷新。</p></div>}<div className="view-label"><span className="view-cross">+</span>透视视角 <span>{renderSize.width} × {renderSize.height}</span></div><div className="axis-indicator"><i className="axis-y">Y</i><i className="axis-x">X</i><i className="axis-z">Z</i></div>{realtimeRecording&&<div className={'record-overlay '+(record.status==='paused'?'paused':'')}><span/>{record.status==='paused'?'录制暂停':record.status==='processing'?'生成视频中':'REC'}<b>{formatTime(record.elapsed)}</b></div>}</div>
      <div className="preview-bottom"><div className="mouse-help"><span>左键</span>旋转<i>·</i><span>滚轮</span>缩放<i>·</i><span>右键</span>平移</div><div className="view-tools"><button title="重置视角（R）" aria-label="重置视角" onClick={()=>engine.current?.resetView()}><RotateCcw size={16}/></button><button title="适配当前形态" aria-label="适配画面" onClick={()=>engine.current?.fitView()}><Focus size={17}/></button><button title="导出 PNG 截图" aria-label="导出截图" onClick={screenshot}><Camera size={17}/></button><span/><button title="全屏展示" aria-label="全屏展示" onClick={fullscreen}><Maximize2 size={17}/></button></div></div>
    </main>
    <aside className="right-panel" inert={exportBusy}><div className="right-tabs"><button className={tab==='params'?'active':''} onClick={()=>setTab('params')}><Settings2 size={15}/>参数</button><button className={tab==='record'?'active':''} onClick={()=>setTab('record')}><Circle size={13}/>导出 / 录制{record.status==='recording'&&<i/>}</button></div><div className="param-scroll">{tab==='params'?<>
      <div className="param-group density-group"><div className="group-heading"><span><Activity size={14}/>密度与设备适配</span><span className="density-priority">流畅优先</span></div>
        <div className="segmented count-mode"><button disabled={activeRecording} aria-pressed={params.autoCount} className={params.autoCount?'active':''} onClick={()=>changeCountMode(true)}>自动适配设备</button><button disabled={activeRecording} aria-pressed={!params.autoCount} className={!params.autoCount?'active':''} onClick={()=>changeCountMode(false)}>手动数量</button></div>
        <div className={'density-status '+(params.autoCount?'automatic':'')} aria-live="polite"><div><span>主体当前绘制</span><strong>{state.actualCount.toLocaleString()}<small> 个</small></strong></div><p>{params.autoCount?state.adaptiveStatus:'手动控制粒子密度'}</p><div className="density-cap">{params.autoCount?'当前有效上限':'素材采样上限'}<b>{(params.autoCount?state.adaptiveCeiling:asset.count).toLocaleString()}</b></div></div>
        <Range label={params.autoCount?'自动数量上限':'粒子数量'} value={params.count} min={1000} max={MAX_PARTICLES} step={1000} unit="个" disabled={activeRecording&&params.autoCount} onChange={v=>change('count',v)} description={params.autoCount?'自动模式的最大预算；实际数量依据连续渲染帧率调整。':'真实绘制数量，受素材有效采样区域限制。'}/>
        <div className="layer-counts"><span>外围点<b>{state.ambientCount.toLocaleString()}</b></span><span>短尾路径<b>{state.filamentCount.toLocaleString()} 组</b></span></div>
        <p className="control-hint">{activeRecording&&params.autoCount?'录制期间固定自动数量；停止并生成视频后恢复设备评估。':params.autoCount?'从 30,000 个主体点起步，按实际流畅度增减。上限是预算，外围点和细丝另计；500,000 个不保证每台设备流畅。':'直接设置实际绘制数量；素材有效像素或表面容量不足时，以采样上限为准。'}</p>
      </div>
      <div className="param-group petal-controls"><div className="group-heading"><span><Layers3 size={14}/>表面与外围微流</span></div>
        <Toggle label="晶亮颗粒" on={params.grainStyle} onChange={()=>change('grainStyle',!params.grainStyle)}/><Toggle label="立体表面质感" on={params.surfaceMode} onChange={()=>change('surfaceMode',!params.surfaceMode)}/>
        {effect==='erosion'&&<Toggle label="花瓣局部侵蚀" on={params.petalFlow} onChange={()=>change('petalFlow',!params.petalFlow)}/>}
        {(params.surfaceMode||params.petalFlow)&&<><Range label="外围粒子比例" value={params.ambient*100} min={0} max={8} step={.1} unit="%" onChange={v=>change('ambient',v/100)} description="外围游动点相对主体的数量预算，不是聚散进度。"/><Range label="外围活动范围" value={params.ambientRange} min={0} max={1} step={.01} onChange={v=>change('ambientRange',v)}/><Range label="外围游动速度" value={params.ambientSpeed} min={0} max={3} step={.05} unit="×" onChange={v=>change('ambientSpeed',v)}/><p className="control-hint">外围微流在原形停留时也可游动，与时间轴的聚散形态独立；暂停动画会冻结游动。</p></>}
      </div>
      {petalTiming&&petalStages&&<div className="param-group petal-timing"><div className="group-heading"><span><AudioLines size={14}/>渐隐回环节奏</span></div>
        <Range label="消散阶段时长" value={petalTiming.disperse} min={.1} max={60} step={.1} unit="s" disabled={playbackLocked} onChange={v=>changePetalDuration('disperse',v)}/><Range label="聚合阶段时长" value={petalTiming.assemble} min={.1} max={60} step={.1} unit="s" disabled={playbackLocked} onChange={v=>changePetalDuration('assemble',v)}/>
        <div className="petal-stage-summary"><b>总长 {Number(clip.duration.toFixed(2))} 秒</b><span>0–{Number(petalStages.holdEnd.toFixed(2))}s 原形与微流</span><span>{Number(petalStages.holdEnd.toFixed(2))}–{Number(petalStages.fadeEnd.toFixed(2))}s 侵蚀、细丝、淡出</span><span>{Number(petalStages.fadeEnd.toFixed(2))}–{Number(petalStages.blackEnd.toFixed(2))}s 黑场</span><span>{Number(petalStages.blackEnd.toFixed(2))}–{Number(petalStages.assembleEnd.toFixed(2))}s 聚合还原</span></div>
        <p className="control-hint">调时长会暂停并移动阶段内已有帧，保留你编辑的姿态。关键帧仍可独立修改，实际画面以时间轴为准。</p>
      </div>}
      <div className="param-group"><div className="group-heading"><span><Sparkles size={14}/>聚散与空间</span></div>
        <div className="shape-label"><span>聚合</span><b>{state.progress<.01?'原始形态':state.progress>.99?'完全散开':'中间形态'}</b><span>消散</span></div><input className="slider shape-slider" aria-label="当前聚散形态" type="range" min="0" max="1" step="0.001" value={state.progress} disabled={playbackLocked} onChange={e=>engine.current?.setProgress(Number(e.target.value))}/>
        <div className="shape-actions"><button disabled={playbackLocked} onClick={()=>engine.current?.command('assemble')}><RotateCcw size={12}/>平滑聚合</button><button disabled={playbackLocked} onClick={()=>engine.current?.command('disperse')}><MoveUpRight size={12}/>平滑消散</button></div><p className="control-hint">手动形态与一键聚散使用自由播放；底部播放按钮回到关键帧动画。当前形态可添加关键帧保存。</p>
        <Range label="空间厚度" value={params.depth} min={0} max={3} step={.05} unit="×半径" onChange={v=>change('depth',v)} description="粒子离开原平面后的前后深度；0 保持图片平面。"/>
        <Range label="独立散开" value={params.scatter} min={0} max={1} step={.01} onChange={v=>change('scatter',v)} description="每颗粒子的独立随机运动，与局部流动叠加。"/>
        <Range label="错峰释放" value={params.stagger} min={0} max={1} step={.01} onChange={v=>change('stagger',v)} description="让不同区域和粒子在不同时间脱离原形。"/>
        {asset.kind==='image'&&<p className="control-hint">聚合时由像素粒子还原图片；散开后进入三维空间。拖动画面可从侧面观察。</p>}
        <Range label="扩散距离" value={params.spread} min={0} max={5} step={.05} unit="×半径" onChange={v=>change('spread',v)}/><Range label="扰动强度" value={params.turbulence} min={0} max={1} step={.01} onChange={v=>change('turbulence',v)}/>
        {effect==='vortex'&&<div className="axis-setting"><span>旋转轴</span><div>{(['x','y','z'] as const).map(axis=><button key={axis} className={params.axis===axis?'active':''} onClick={()=>change('axis',axis)}>{axis.toUpperCase()}</button>)}</div></div>}
        {['directional','wave','erosion'].includes(effect)&&<div className="direction-setting"><label htmlFor="flow-direction">{effect==='wave'?'传播方向':'流动方向'}</label><select id="flow-direction" value={params.direction} onChange={e=>change('direction',e.target.value as ParticleParams['direction'])}>{[['x','向右 +X'],['-x','向左 −X'],['y','向上 +Y'],['-y','向下 −Y'],['z','向前 +Z'],['-z','向后 −Z']].map(([v,label])=><option key={v} value={v}>{label}</option>)}</select></div>}
        {effect==='wave'&&<Range label="传播节奏" value={params.waveRhythm} min={.3} max={3} step={.05} unit="×" onChange={v=>change('waveRhythm',v)}/>}
        {effect==='erosion'&&<><Range label="侵蚀强度" value={params.erosion} min={0} max={1} step={.01} onChange={v=>change('erosion',v)} description="控制各区域消散节奏和局部孔洞。"/><Range label="流场尺度" value={params.flowScale} min={.3} max={5} step={.05} unit="×" onChange={v=>change('flowScale',v)}/><Range label="拉丝强度" value={params.stringiness} min={0} max={3} step={.05} unit="×" onChange={v=>change('stringiness',v)}/></>}
        {effect==='erosion'&&<Range label="卷曲力度" value={params.curl} min={0} max={3} step={.05} unit="×" onChange={v=>change('curl',v)} description="控制流场侵蚀中相邻粒子沿连续卷曲流线展开的力度。"/>}
        <Range label="短拖尾长度" value={params.trail} min={0} max={1} step={.01} onChange={v=>change('trail',v)} description="0关闭；沿粒子运动方向生成短点状尾迹，聚合时消失。"/><Toggle label="末段平滑淡出" on={params.fade} onChange={()=>change('fade',!params.fade)}/>
      </div>
      <div className="param-group output-controls"><div className="group-heading"><span><Focus size={14}/>输出画面</span></div><div className="segmented resolution-mode">{(['720p','1080p'] as const).map(resolution=><button key={resolution} disabled={activeRecording} aria-pressed={params.resolution===resolution} className={params.resolution===resolution?'active':''} onClick={()=>change('resolution',resolution)}>{resolution.toUpperCase()}</button>)}</div><p className="control-hint">当前画布 {renderSize.width} × {renderSize.height}。导出视频可独立选择高清尺寸。{activeRecording?'录制结束前保持尺寸。':'1080p 更清晰，也需要更多图形性能。'}</p></div>
      <div className="param-group"><div className="group-heading"><span><Image size={14}/>粒子外观</span><button title="重置外观" aria-label="重置外观" onClick={()=>reset(['size','color','opacity','glow','colorMode','exposure','contrast','sparkle','grainStyle'])}><RotateCcw size={12}/></button></div>
        <Range label="粒子大小" value={params.size} min={.5} max={8} step={.05} unit="px" onChange={v=>change('size',v)}/>
        <div className="segmented color-mode"><button className={params.colorMode==='original'?'active':''} disabled={!asset.hasOriginalColors} onClick={()=>change('colorMode','original')}>素材原色</button><button className={params.colorMode==='uniform'?'active':''} onClick={()=>change('colorMode','uniform')}>统一颜色</button></div>
        {params.colorMode==='uniform'&&<><div className="color-row"><span>粒子颜色</span><div className="color-input"><input aria-label="粒子颜色" type="color" value={params.color} onChange={e=>change('color',e.target.value)}/><span>{params.color.toUpperCase()}</span><ChevronDown size={12}/></div></div><div className="color-swatches">{['#b6a4ff','#a6dfe9','#e6bbda','#d9edba','#ffbd82','#ffffff'].map(color=><button key={color} style={{background:color}} className={params.color===color?'active':''} aria-label={'使用颜色 '+color} onClick={()=>change('color',color)}/>)}</div></>}
        <Range label="透明度" value={params.opacity*100} min={0} max={100} unit="%" onChange={v=>change('opacity',v/100)}/><Range label="泛光强度" value={params.glow*100} min={0} max={200} unit="%" onChange={v=>change('glow',v/100)} description="真实画面泛光，亮点和细流的光晕会进入截图与视频。"/>
        <Range label="粒子亮度" value={params.exposure} min={.3} max={3} step={.05} unit="×" onChange={v=>change('exposure',v)}/><Range label="对比层次" value={params.contrast} min={.5} max={2} step={.05} unit="×" onChange={v=>change('contrast',v)}/><Range label="亮核比例" value={params.sparkle} min={0} max={1} step={.01} onChange={v=>change('sparkle',v)} description="少量高亮细点与微弱闪烁，让密集粒子保留疏密和层次。"/>
      </div>
      <div className="param-group"><div className="group-heading"><span><AudioLines size={14}/>运动与观察</span></div>
        <Range label="粒子运动速度" value={params.motionSpeed} min={0} max={3} step={.05} unit="×" onChange={v=>change('motionSpeed',v)}/><Range label="播放倍率" value={params.playbackRate} min={.25} max={4} step={.05} unit="×" onChange={v=>change('playbackRate',v)}/><Range label="一键过渡时长" value={params.duration} min={.5} max={20} step={.5} unit="s" onChange={v=>change('duration',v)} description="一键聚散的单程时长；关键帧按时间轴播放。"/><Toggle label="自动环绕" on={params.autoRotate} onChange={()=>change('autoRotate',!params.autoRotate)}/>{params.autoRotate&&<Range label="环绕速度" value={params.rotationSpeed} min={.1} max={3} step={.1} unit="×" onChange={v=>change('rotationSpeed',v)}/>}
      </div><button className="reset-all" onClick={()=>{applyParameterPatch({...DEFAULT_PARAMS});notify(activeRecording?'效果参数已重置，录制中的数量模式保持。':'效果参数已重置，素材与关键帧保留。');}}><RotateCcw size={13}/>重置效果参数</button>
    </>:<div className="record-panel">
      <div className="record-title"><span className="eyebrow">HIGH DEFINITION</span><h2>清晰，也流畅。</h2><p>导出整个时间轴，每一帧完整生成。</p></div>
      <div className="export-settings">
        <label htmlFor="export-resolution">视频分辨率</label><select id="export-resolution" disabled={activeRecording} value={resolution} onChange={e=>{const next=e.target.value as '1080'|'2160';setResolution(next);if(next==='2160')setExportFps(30);}}><option value="1080">1080p 全高清 · 1920 × 1080</option><option value="2160">4K 超高清 · 3840 × 2160</option></select>
        <label htmlFor="export-fps">视频帧率</label><select id="export-fps" disabled={activeRecording} value={exportFps} onChange={e=>setExportFps(Number(e.target.value) as 30|60)}><option value="60" disabled={resolution==='2160'}>60 FPS · 更流畅</option><option value="30">30 FPS</option></select>
      </div>
      <div className="quality-setting"><label>编码画质</label><div><button disabled={activeRecording} className={quality==='standard'?'active':''} onClick={()=>setQuality('standard')}>标准</button><button disabled={activeRecording} className={quality==='high'?'active':''} onClick={()=>setQuality('high')}>高画质</button></div></div>
      <div className="record-spec"><div><span>输出尺寸</span><b>{outputWidth} × {outputHeight}</b></div><div><span>固定帧率</span><b>{exportFps} FPS</b></div><div><span>格式 / 码率</span><b>MP4 / {Math.round(getExportBitrate(outputWidth,outputHeight,exportFps,quality)/1000000)} Mbps</b></div><div><span>完整动画</span><b>{(clip.duration/params.playbackRate).toFixed(1)} 秒</b></div></div>
      <button className="primary record-start" disabled={activeRecording||!engineReady||importBusy||!isHDVideoExportSupported()} onClick={()=>void startHDExport()}><ArrowDownToLine size={15}/>导出高清视频</button>
      <p className="record-note">按固定帧率生成整个时间轴，预览卡顿不会减少视频帧数。4K 导出耗时更长；需要保持页面打开。</p>
      {exportError&&<p className="warning" role="alert">{exportError}</p>}
      {!isHDVideoExportSupported()&&<p className="warning">此浏览器不支持高清导出，请使用最新版 Chrome 或 Edge。</p>}
      {exportResult&&<div className="result-actions"><button className="secondary" onClick={()=>{setVideoSource('export');setVideoOpen(true);}}><Play size={14}/>预览高清</button><button className="secondary" onClick={()=>downloadVideo(exportResult)}><ArrowDownToLine size={14}/>下载 MP4</button></div>}
      <div className="divider"/><div className="section-title"><span>自由录制 · 1080p / 60 FPS 目标</span></div>
      <p className="record-note">记录现场操作和视角变化，流畅度取决于实时帧率。平滑动画请选择上方高清导出。</p>
      <div className="record-status-box"><span className={'status-light '+record.status}/><strong>{({idle:'准备就绪',recording:'正在录制',paused:'录制已暂停',processing:'正在生成视频',ready:'视频已生成',error:'录制出错'})[record.status]}</strong><b>{formatTime(record.elapsed)}</b></div>
      {!realtimeRecording?<button className="secondary record-start" disabled={!supported||!engineReady||importBusy||exportBusy} onClick={startRealtimeRecording}><Circle size={14}/>{record.status==='ready'?'重新录制':'开始自由录制'}</button>:<div className="record-actions"><button className="secondary" disabled={record.status==='processing'} onClick={()=>record.status==='paused'?recorder.current?.resume():recorder.current?.pause()}>{record.status==='paused'?<Play size={14}/>:<Pause size={14}/>} {record.status==='paused'?'继续录制':'暂停录制'}</button><button className="stop-record" disabled={record.status==='processing'} onClick={()=>recorder.current?.stop()}><Square size={12}/>停止并生成</button></div>}
      {record.result&&<div className="result-actions"><button className="secondary" onClick={()=>{setVideoSource('record');setVideoOpen(true);}}><Play size={14}/>预览录像</button><button className="secondary" onClick={()=>downloadVideo(record.result!)}><ArrowDownToLine size={14}/>下载</button></div>}
      <div className="record-limits"><span>自由录制上限 120 秒</span><span>200 MB</span><span>{(record.bytes/1024/1024).toFixed(1)} MB</span></div>{!supported&&<p className="warning">当前浏览器不支持自由录制。</p>}
    </div>}</div></aside>
    <footer className="timeline-workspace" inert={exportBusy}><div className="timeline-status"><span><i className={state.running?'playing':''}/>{state.running?(state.playbackSource==='timeline'?'关键帧播放中':'自由聚散中'):(state.playbackSource==='timeline'?'时间轴已暂停':'自由聚散已暂停')}<kbd>Space</kbd>播放 / 暂停</span><span>{current.name}<b>主体 {state.actualCount.toLocaleString()} · 外围 {state.ambientCount.toLocaleString()} · 短尾 {state.filamentCount.toLocaleString()} 组</b><em>{!state.running&&!params.autoRotate&&record.status!=='recording'?'静止 · 按需渲染':Math.round(state.fps)+' FPS'}</em></span></div>
      {petalTiming&&<div className="petal-phase-line"><Sparkles size={11}/><span>预设阶段：{state.playbackSource==='timeline'?petalPhaseAt(state.timelineTime,petalTiming):'自由形态编辑'}</span><small>独立消散 / 聚合时长在右侧调整 · 时间轴以秒计</small></div>}
      <TimelinePanel clip={clip} time={state.timelineTime} playing={state.running&&state.playbackSource==='timeline'} loop={state.timelineLoop} currentSample={currentSample} getCurrentFrame={()=>({time:engine.current?.state.timelineTime??state.timelineTime,sample:engine.current?.currentSample??currentSample})} onClipChange={changeClip} onSeek={t=>engine.current?.seekTimeline(t)} onTogglePlay={()=>{const e=engine.current;if(e)e.setTimelinePlaying(!(e.state.running&&e.state.playbackSource==='timeline'));}} onLoopChange={v=>engine.current?.setTimelineLoop(v)} disabled={!engineReady||playbackLocked}/>
    </footer>
    {presentation&&<button className="secondary exit-presentation" onClick={fullscreen}><Maximize2 size={14}/>退出展示 <kbd>ESC</kbd></button>}
    {exportBusy&&<div className="modal-backdrop export-backdrop"><section className="modal hd-progress" role="dialog" aria-modal="true" aria-labelledby="hd-progress-title"><LoaderCircle className="spin" size={30}/><h2 id="hd-progress-title">正在生成高清视频</h2><p>{outputWidth} × {outputHeight} · {exportFps} FPS · MP4</p><progress aria-label="视频导出进度" max="1" value={exportProgress}/><strong>{Math.round(exportProgress*100)}%</strong><p>每一帧完整生成，请保持页面打开。</p><button className="secondary" autoFocus onClick={()=>exportAbort.current?.abort()}>取消导出</button></section></div>}
    {toast&&<div className="toast" role="status"><Check size={15}/>{toast}<button aria-label="关闭提示" onClick={()=>setToast('')}><X size={14}/></button></div>}
    {importOpen&&<div className="modal-backdrop" onClick={()=>setImportOpen(false)}><section className={'modal import-modal '+(dragging?'dragging':'')} role="dialog" aria-modal="true" aria-labelledby="import-title" onClick={e=>e.stopPropagation()} onDragOver={e=>{e.preventDefault();e.stopPropagation();setDragging(true);}} onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setDragging(false);}} onDrop={dropFiles}>
      <div className="modal-heading"><div><span className="eyebrow">BRING YOUR MATERIAL</span><h2 id="import-title">让素材变成粒子。</h2></div><button className="icon-button" aria-label="关闭素材导入" onClick={()=>setImportOpen(false)}><X size={20}/></button></div>
      <button className={'drop-zone '+(dragging?'dragging':'')} disabled={activeRecording} onClick={()=>fileRef.current?.click()}>{importBusy?<LoaderCircle className="spin" size={31}/>:<Upload size={31}/>}<strong>{importBusy?'正在处理 '+importState.name:dragging?'松开以导入素材':'拖入图片或 GLB 模型'}</strong><span>{importBusy?'仍可选择其他文件，以最后一次选择为准':'或点击这里，从电脑选择文件'}</span><small>PNG · JPG · JPEG · GLB</small></button>
      {importState.status==='error'&&<div className="import-error" role="alert"><strong>未能导入 {importState.name}</strong><p>{importState.error}</p><small>原有素材已保留，可重新选择文件。</small></div>}
      <div className="import-formats"><div><Image size={18}/><b>图片</b><p>保留宽高比和原色。透明区域自动过滤；JPG 保留背景。</p></div><div><Box size={18}/><b>静态 3D 模型</b><p>GLB 多网格表面采样。支持基色、顶点色与基础色贴图。</p></div></div>
      <div className="reference-example uploaded-example"><button disabled={activeRecording||importBusy} onClick={loadUploadedDemo}><img src={publicAssetUrl('/examples/uploaded-model-preview.jpg')} alt="用户提供的双朵百合三维模型"/><span><b>你的百合花束 · 导入模型预设</b><small>来自原始 GLB · 完整三维 / 原色 / 36 秒动画</small></span><Play size={17}/></button><a href={publicAssetUrl('/examples/uploaded-model.glb')} download="Lily_Bouquet.glb">下载网页优化 GLB <ArrowDownToLine size={13}/></a></div>
      <p className="import-capacity">GLB 支持最大 256 MiB / 500 万三角面，自动采样为粒子。</p>
      <div className="example-heading"><span>先试试示例</span><small>无需准备文件</small></div><div className="example-grid"><div><button disabled={activeRecording} onClick={()=>example(publicAssetUrl('/examples/color-flower.png'),'color-flower.png')}><img src={publicAssetUrl('/examples/color-flower.png')} alt="粉色花瓣与黄色花蕊的透明花朵"/><span><b>彩色花朵</b><small>透明 PNG / 原色粒子</small></span><ArrowUpRight size={17}/></button><a href={publicAssetUrl('/examples/color-flower.png')} download>下载图片 <ArrowDownToLine size={12}/></a></div><div><button disabled={activeRecording} onClick={()=>example(publicAssetUrl('/examples/sample-sphere.glb'),'sample-sphere.glb')}><span className="model-example"><Box size={33}/></span><span><b>三维组合</b><small>GLB / 多网格与颜色</small></span><ArrowUpRight size={17}/></button><a href={publicAssetUrl('/examples/sample-sphere.glb')} download>下载模型 <ArrowDownToLine size={12}/></a></div></div>
      <div className="reference-example lily-example"><button disabled={activeRecording||importBusy} onClick={loadWhiteLilyDemo}><img src={publicAssetUrl('/examples/white-lily-preview-front.png')} alt="参考照片制作的白百合立体近似"/><span><b>白百合 · 自然风蚀</b><small>白色花瓣 / 淡绿花心与棕色花药 / 36 秒渐隐回环</small></span><Play size={17}/></button><a href={publicAssetUrl('/examples/white-lily-model.glb')} download="Particle_White_Lily.glb">下载白百合 GLB 模型 <ArrowDownToLine size={13}/></a><a href={publicAssetUrl('/examples/white-lily-reference.png')} download="White_Lily_Reference.png">下载白百合参考图 <ArrowDownToLine size={13}/></a></div>
      <div className="reference-example petal-example"><button disabled={activeRecording||importBusy} onClick={()=>loadPetalDemo()}><img src={publicAssetUrl('/examples/petal-preview-front.png')} alt="粉色花瓣和橙黄色花心的立体花朵"/><span><b>花瓣微流 · 立体花朵</b><small>三维表面 / 稀疏外围 / 36 秒渐隐回环</small></span><Play size={17}/></button><a href={publicAssetUrl('/examples/petal-model.glb')} download="Particle_Petal.glb">下载花瓣 GLB 模型 <ArrowDownToLine size={13}/></a></div>
      <div className="reference-example ding-example"><button disabled={activeRecording||importBusy} onClick={loadDingDemo}><img src={publicAssetUrl('/examples/ding-reference.jpg')} alt="青铜方鼎正视参考图"/><span><b>青铜方鼎 · 三维粒子展示</b><small>青铜原色 / 四足双耳 / 16 秒聚散动画</small></span><Play size={17}/></button><a href={publicAssetUrl('/examples/ding-model.glb')} download="Bronze_Ding.glb">下载青铜方鼎 GLB <ArrowDownToLine size={13}/></a></div>
      <div className="reference-example lily-example"><button disabled={activeRecording} onClick={loadLilyDemo}><img src={publicAssetUrl('/examples/lily-reference.jpg')} alt="用于彩色百合模型的参考照片"/><span><b>你的百合 · 彩色 3D 模型</b><small>参考照片的立体近似 · 原色 / 12 秒动画</small></span><Play size={17}/></button><a href={publicAssetUrl('/examples/lily-model.glb')} download="Particle_Lily.glb">下载彩色 GLB 模型 <ArrowDownToLine size={13}/></a></div>
      <div className="reference-example"><button disabled={activeRecording} onClick={loadReferenceDemo}><img src={publicAssetUrl('/examples/particle-flower-reference.jpg')} alt="你提供的彩色流线花朵"/><span><b>你的参考图 · 图片展示</b><small>原色粒子 · 12 秒聚散 / 缩放 / 旋转动画</small></span><Play size={17}/></button></div>
      <div className="import-footer"><span>素材在浏览器本地处理</span><button disabled={activeRecording} onClick={()=>runImport('粒子球体',async()=>createSphereAsset())}><RotateCcw size={12}/>恢复内置球体</button></div>
    </section></div>}
    {help&&<div className="modal-backdrop" onClick={()=>setHelp(false)}><section className="modal help-modal" onClick={e=>e.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">QUICK START</span><h2>从素材到一段动画</h2></div><button className="icon-button" aria-label="关闭操作说明" onClick={()=>setHelp(false)}><X size={20}/></button></div><ol><li><b>导入素材</b><span>左上打开导入窗口，选择或拖入图片 / GLB，也可直接加载花朵或三维组合示例。</span></li><li><b>设计粒子变化</b><span>选择六种效果。右侧可调当前形态、侵蚀、拉丝、拖尾和淡出；原色模式保留素材颜色。</span></li><li><b>给变化打帧</b><span>拖动底部秒时间轴到目标位置，点击“添加关键帧”，编辑缩放、XYZ 旋转与聚散形态。修改会暂停，空格预览。</span></li><li><b>观察与记录</b><span>左键旋转相机，滚轮缩放，右键平移；R 重置视角。录制只包含画布，可预览并下载视频。</span></li></ol><p className="help-limit">图片是三维空间中的薄平面；模型支持静态表面。骨骼动画、Draco / KTX2 压缩数据和高级材质暂不支持。高清导出支持 1080p / 60 FPS 与 4K / 30 FPS；自由录制为 1080p / 目标 60 FPS。关键帧缩放与旋转作用于素材。</p><button className="primary" onClick={()=>setHelp(false)}>开始创作 <ArrowUpRight size={15}/></button></section></div>}
    {videoOpen&&videoResult&&<div className="modal-backdrop" onClick={()=>setVideoOpen(false)}><section className="modal video-modal" onClick={e=>e.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">YOUR CREATION</span><h2>粒子影像已生成</h2></div><button className="icon-button" aria-label="关闭视频预览" onClick={()=>setVideoOpen(false)}><X size={20}/></button></div><video src={videoResult.url} controls playsInline preload="metadata"/><div className="video-meta"><span>{videoResult.duration.toFixed(2)} 秒</span><span>{videoResult.width} × {videoResult.height}</span><span>{videoResult.extension.toUpperCase()}</span><span>{videoSource==='export'&&videoResult.fps?videoResult.fps+' FPS':'实时录制'}</span><span>{(videoResult.blob.size/1024/1024).toFixed(2)} MB</span></div><div className="video-buttons"><button className="secondary" onClick={()=>{setVideoOpen(false);setTab('record');}}>返回编辑</button><button className="primary" onClick={()=>downloadVideo(videoResult)}><ArrowDownToLine size={16}/>下载视频</button></div></section></div>}
  </div>;
}
