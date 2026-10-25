
import {particleVertexShader,particleFragmentShader} from '/src/shaders.ts';
const report={status:'running',checks:[],metrics:{}};let gl;
try{
 gl=document.createElement('canvas').getContext('webgl2');if(!gl)throw Error('WebGL 2不可用');
 const anchors=64,steps=24,stride=25,count=anchors*stride,cols=32,cell=8,width=cols*cell,height=Math.ceil(count/cols)*cell;
 const origins=new Float32Array(count*3),histories=new Float32Array(count*3),normals=new Float32Array(count*3),surfaces=new Float32Array(count*3),seeds=new Float32Array(count*3),colours=new Float32Array(count*3);
 let randomState=0x194a17;const random=()=>{randomState^=randomState<<13;randomState^=randomState>>>17;randomState^=randomState<<5;return(randomState>>>0)/4294967296;};
 for(let a=0;a<anchors;a++){const angle=a/anchors*Math.PI*2,seed=[random(),random(),random()];for(let h=0;h<stride;h++){const i=(a*stride+h)*3;origins.set([Math.cos(angle)*.72,Math.sin(angle)*.62,Math.sin(angle*2)*.08],i);histories[i]=h/steps;normals.set([Math.cos(angle)*.1,Math.sin(angle)*.1,1],i);surfaces.set([a/anchors,.7,a<48?0:1],i);seeds.set(seed,i);colours.set(a<48?[.8,.09,.3]:[.85,.5,.025],i);}}
 function compile(type,source){const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(shader));return shader;}
 function makeProgram(kind,grid=false){
  const trail=kind==='particle'||kind==='line',particle=kind==='particle',defines=(trail?'#define TRAIL 1\n':'')+(particle?'#define PARTICLE_TRAIL 1\n':'');
  let vertex=particleVertexShader.replaceAll('attribute ','in ').replaceAll('varying ','out ').replaceAll('texture2D(', 'texture(');
  const expected=particle?`float testedAge = petalAge(original, uProgress);
    float testedProgress = mix(min(uProgress, 0.94), uProgress, uFade);
    float testedShrink = mix(1.0, 0.25, smoothstep(0.8, 0.985, testedProgress));
    float testedPastAge = max(0.0, testedAge - history * (0.04 + uTrail * 0.2) * testedShrink);
    float testedPastTime = max(0.0, uTime - history * uTrail * 0.35 * uMotionSpeed * testedShrink);
    expectedPosition = petalPosition(original, testedPastAge, testedPastTime);`:kind==='drift'?'expectedPosition = petalDrift(original);':'expectedPosition = petalPosition(original, petalAge(original, uProgress), uTime);';
  vertex=vertex.replace('vec4 viewPosition =',`testedPosition = displaced;\n ${expected}\n vec4 viewPosition =`);
  if(grid)vertex=vertex.replace('gl_PointSize *= max(1.0, uOutputScale);',`gl_PointSize = 6.0;
    float testId = float(gl_VertexID);
    vec2 testPixel = vec2(mod(testId, ${cols}.0) * ${cell}.0 + 4.0, floor(testId / ${cols}.0) * ${cell}.0 + 4.0);
    gl_Position = vec4(testPixel / vec2(${width}.0, ${height}.0) * 2.0 - 1.0, 0.0, 1.0);`);
  const prefix='#version 300 es\nprecision highp float;\n'+defines;
  vertex=prefix+'in vec3 position;uniform mat4 modelViewMatrix;uniform mat4 projectionMatrix;uniform mat3 normalMatrix;out vec3 testedPosition;out vec3 expectedPosition;\n'+vertex;
  const fragment=prefix+'out vec4 finalColour;\n'+particleFragmentShader.replaceAll('varying ','in ').replaceAll('gl_FragColor','finalColour');
  const program=gl.createProgram();gl.attachShader(program,compile(gl.VERTEX_SHADER,vertex));gl.attachShader(program,compile(gl.FRAGMENT_SHADER,fragment));gl.transformFeedbackVaryings(program,['testedPosition','expectedPosition'],gl.INTERLEAVED_ATTRIBS);gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
  const vao=gl.createVertexArray();gl.bindVertexArray(vao);for(const[name,data]of[['position',trail?histories:origins],['aOrigin',origins],['aSeed',seeds],['aColor',colours],['aNormal',normals],['aSurface',surfaces]]){const location=gl.getAttribLocation(program,name);if(location<0)continue;const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,3,gl.FLOAT,false,0,0);}return{program,vao};
 }
 const point=makeProgram('point'),particle=makeProgram('particle'),oldLine=makeProgram('line'),particleGrid=makeProgram('particle',true),mainGrid=makeProgram('point',true),lineGrid=makeProgram('line',true),driftProgram=makeProgram('drift');
 const texture=gl.createTexture();gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1025,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(4100));gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
 const feedback=gl.createTransformFeedback(),output=gl.createBuffer();gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK,feedback);gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER,output);gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER,count*6*4,gl.DYNAMIC_READ);gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER,0,output);
 const target=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,target);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
 const fbo=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,target,0);if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error('离屏目标不完整');gl.bindTexture(gl.TEXTURE_2D,texture);
 const id4=new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]),id3=new Float32Array([1,0,0,0,1,0,0,0,1]);
 const defaults={uMode:5,uPetalFlow:1,uSurfaceMode:1,uProgress:.85,uTime:7.15,uDepth:1.2,uScatter:.06,uStagger:.65,uIsImage:0,uSpread:.6,uTurbulence:.14,uFlowScale:1.25,uStringiness:2.2,uErosion:.8,uWaveRhythm:1,uAxis:1,uCurl:1.8,uSparkle:.06,uDensityOpacity:1,uSize:1.05,uOutputScale:1,uTrail:.55,uTimelineActive:0,uTrailTimeSpan:.3,uTrailProgressSpan:.12,uOpacity:.94,uGlow:.3,uFade:1,uOriginalColor:1,uTimelineDuration:36,uMotionSpeed:.55};
 function use(item,parameters){gl.useProgram(item.program);gl.bindVertexArray(item.vao);for(const[name,value]of Object.entries({...defaults,...parameters}))gl.uniform1f(gl.getUniformLocation(item.program,name),value);gl.uniform1i(gl.getUniformLocation(item.program,'uProgressHistory'),0);gl.uniform3f(gl.getUniformLocation(item.program,'uDirection'),0,1,0);gl.uniform3f(gl.getUniformLocation(item.program,'uColor'),.8,.09,.3);gl.uniformMatrix4fv(gl.getUniformLocation(item.program,'modelViewMatrix'),false,id4);gl.uniformMatrix4fv(gl.getUniformLocation(item.program,'projectionMatrix'),false,id4);gl.uniformMatrix3fv(gl.getUniformLocation(item.program,'normalMatrix'),false,id3);}
 function sample(item,parameters={}){use(item,parameters);gl.enable(gl.RASTERIZER_DISCARD);gl.beginTransformFeedback(gl.POINTS);gl.drawArrays(gl.POINTS,0,count);gl.endTransformFeedback();gl.disable(gl.RASTERIZER_DISCARD);const data=new Float32Array(count*6);gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER,0,data);const error=gl.getError();if(error!==gl.NO_ERROR)throw Error('TF WebGL error '+error);return data;}
 function alphaSample(item,p,fade=1){use(item,{uProgress:p,uFade:fade});gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);gl.viewport(0,0,width,height);gl.disable(gl.BLEND);gl.disable(gl.DEPTH_TEST);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.drawArrays(gl.POINTS,0,count);const rgba=new Uint8Array(width*height*4);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,rgba);let alive=0,sum=0;for(let i=0;i<count;i++){const x=(i%cols)*cell+4,y=Math.floor(i/cols)*cell+4,a=rgba[(y*width+x)*4+3];if(a>0)alive++;sum+=a;}const error=gl.getError();if(error!==gl.NO_ERROR)throw Error('fragment WebGL error '+error);return{alive,meanAlpha:sum/count};}
 function check(name,passed,detail){report.checks.push({name,passed:!!passed,...(detail?{detail}:{})});if(!passed)throw Error(name);}
 const baseline=sample(particle),heads=sample(point);let maxError=0,maxHeadError=0,maxDistance=0;
 for(let i=0;i<count;i++){for(let c=0;c<3;c++)maxError=Math.max(maxError,Math.abs(baseline[i*6+c]-baseline[i*6+c+3]));const head=Math.floor(i/stride)*stride;maxDistance=Math.max(maxDistance,Math.hypot(...[0,1,2].map(c=>baseline[i*6+c]-heads[head*6+c])));if(i%stride===0)for(let c=0;c<3;c++)maxHeadError=Math.max(maxHeadError,Math.abs(baseline[i*6+c]-heads[i*6+c]));}
 report.metrics={maxPathError:maxError,maxHeadError,maxDistanceToCurrentHead:maxDistance,anchors,samplesPerPath:stride};
 check('生产主点、旧线、新尾点的vertex/fragment均实际编译链接',true);
 check('尾点完全沿真实粒子函数历史路径，无附加coil',maxError<=2e-6,{maxError});
 check('history=0精确连接实际主体位置',maxHeadError===0,{maxHeadError});
 check('历史尾点保持局部有限范围',baseline.every(Number.isFinite)&&maxDistance<.65,{maxDistance});
 const zero=sample(particle,{uProgress:0});check('p=0所有历史样点精确还原原点',origins.every((value,i)=>value===zero[Math.floor(i/3)*6+i%3]));
 sample(particle,{uProgress:1,uTime:30});sample(particle,{uProgress:.2,uTime:0});const repeated=sample(particle);check('同时间同进度重复求值完全一致',baseline.every((value,i)=>value===repeated[i]));
 const oldWave=sample(oldLine,{uMode:4,uPetalFlow:0}),flagWave=sample(oldLine,{uMode:4,uPetalFlow:1});check('旧wave轨迹不受花瓣末段开关影响',oldWave.every((value,i)=>value===flagWave[i]));
 let previous=sample(point,{uProgress:0}),backward=0,movedAtMiddle=0,minFinalForward=Infinity,maxDepthDelta=-Infinity,minDepthDelta=Infinity,maxFinalDistance=0;const directions=sample(driftProgram);report.metrics.openFlow=[];
 for(const p of[.12,.3,.5,.7,.9,1]){const current=sample(point,{uProgress:p});let moved=0,minForward=Infinity;for(let a=0;a<anchors;a++){const i=a*stride*6,o=a*stride*3,delta=[0,1,2].map(c=>current[i+c]-origins[o+c]),drift=[0,1,2].map(c=>directions[i+3+c]),forward=delta.reduce((sum,value,c)=>sum+value*drift[c],0),priorForward=[0,1,2].reduce((sum,c)=>sum+(previous[i+c]-origins[o+c])*drift[c],0);if(forward<priorForward-2e-6)backward++;if(Math.hypot(...delta)>.15)moved++;minForward=Math.min(minForward,forward);if(p===1){minFinalForward=Math.min(minFinalForward,forward);maxFinalDistance=Math.max(maxFinalDistance,Math.hypot(...delta));maxDepthDelta=Math.max(maxDepthDelta,delta[2]);minDepthDelta=Math.min(minDepthDelta,delta[2]);}}if(p===.7)movedAtMiddle=moved;report.metrics.openFlow.push({progress:p,moved,minForward});previous=current;}
 check('每个局部偏流方向持续向前，粒子不会终点绕回原形',backward===0&&minFinalForward>.25,{backward,minFinalForward});
 check('默认spread末段位移保持有界，不靠远离画面退场',maxFinalDistance<1.1,{maxFinalDistance});
 check('中段多数粒子已真正离开原位置，不只是轮廓变透明',movedAtMiddle>=anchors*.5,{movedAtMiddle,anchors});
 check('开放漂移具有不同深度层次',maxDepthDelta-minDepthDelta>.03,{depthDeltaSpan:maxDepthDelta-minDepthDelta});
 const flat=sample(point,{uProgress:.75,uDepth:0});check('depth=0仍能有意保持薄平面位移',Array.from({length:count},(_,i)=>i).every(i=>flat[i*6+2]===origins[i*3+2]));
 report.metrics.fragment={};for(const p of[0,.18,.45,.65,.72,.85,.92,.97,1])report.metrics.fragment[p]={main:alphaSample(mainGrid,p),particles:alphaSample(particleGrid,p),oldLines:alphaSample(lineGrid,p)};
 check('p=0粒子尾迹完全不可见',report.metrics.fragment[0].particles.alive===0);
 check('粒子尾迹已在早中段出现，不再等到末段才切换',report.metrics.fragment[.45].particles.alive>0&&report.metrics.fragment[.65].particles.alive>0);
 check('p=.85和.92原主体仍有可见碎点',report.metrics.fragment[.85].main.alive>0&&report.metrics.fragment[.92].main.alive>0);
 check('末段保留实际尾点并逐步碎散',report.metrics.fragment[.72].particles.alive>0&&report.metrics.fragment[.92].particles.alive>0&&report.metrics.fragment[.97].particles.alive<report.metrics.fragment[.85].particles.alive);
 check('花瓣预设所有阶段都没有线段渲染',Object.values(report.metrics.fragment).every(value=>value.oldLines.alive===0));
 check('p=1淡出时主体和新旧尾层全黑',Object.values(report.metrics.fragment[1]).every(value=>value.alive===0));
 const fadeOff={main:alphaSample(mainGrid,1,0),particles:alphaSample(particleGrid,1,0)};report.metrics.fadeOff=fadeOff;check('关闭淡出后p=1仍保留可见散开粒子',fadeOff.main.alive>0&&fadeOff.particles.alive>0);
 report.status='passed';report.total=report.checks.length;
}catch(error){report.status='failed';report.error=String(error.stack||error);}
finally{gl?.getExtension('WEBGL_lose_context')?.loseContext();}
document.querySelector('#result').textContent=JSON.stringify(report,null,2);document.documentElement.dataset.status=report.status;
