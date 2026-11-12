import '@videojs/html/video/player';
import '@videojs/html/video/skin';
import {createFocusTracker,tuning} from './focus.js';
import {mountDevPanel} from './devpanel.js';
import {detectFaces,clearFaces,facesReady} from './faces.js';
import {createGpuFilm, scheduleFrame} from './gpu.js';
import {createEdgeGlow,edgeGlowSettings} from './edgeglow.js';
const $=id=>document.getElementById(id),video=$('video'),player=$('player'),canvas=$('ambient'),ctx=canvas.getContext('2d',{alpha:true});
let frameId,lastPaint=0,ambientOn=true,inPip=false,objectURL,mode='ambient';
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
function status(s){$('status').textContent=s}
// Display-refresh loop, not requestVideoFrameCallback: with the GPU renderer on, the <video> is invisible
// (opacity 0) and Chrome can stop presenting its frames, so video-frame callbacks stopped and the picture froze
// while playback carried on.
function stopFrames(){if(frameId!==undefined){frameId();frameId=undefined}}
// Original Ambient Fade: sample one decoded video into the soft background layer.
// Draw the video where it actually sits inside the glow canvas, then smear its edge pixels outward.
// Keeps the glow registered to the picture for any aspect ratio (portrait no longer stretches).
let glowGeom=null;
function measureGlow(){const cr=canvas.getBoundingClientRect(),vr=video.getBoundingClientRect();if(!cr.width||!vr.width||!video.videoWidth){glowGeom=null;return}
 const w=160,h=Math.max(24,Math.round(160*cr.height/cr.width));if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h}
 const k=w/cr.width;glowGeom={x:(vr.left-cr.left)*k,y:(vr.top-cr.top)*k,w:vr.width*k,h:vr.height*k,vw:video.videoWidth,vh:video.videoHeight}}
// Halo smoothing: each frame's halo is composed off-screen, then blended into the visible canvas over ~0.15 s.
// Drawn straight, a fast handheld pan through foliage (Chase) changed the halo completely every frame and it
// shimmered. haloSnap makes the next frame replace it outright (new scene, seek, cut).
const haloStage=document.createElement('canvas'),haloStageCtx=haloStage.getContext('2d');let haloSnap=true,haloLast=0;
function drawAmbient(){
 if(haloStage.width!==canvas.width||haloStage.height!==canvas.height){haloStage.width=canvas.width;haloStage.height=canvas.height;haloSnap=true}
 const out=ctx;{const ctx=haloStageCtx;composeHalo(ctx)}
 const now=performance.now(),dt=Math.min(.25,(now-(haloLast||now))/1000);haloLast=now;
 const k=haloSnap||focus.state.cut?1:1-Math.exp(-dt/.15);haloSnap=false;
 out.globalCompositeOperation='destination-in';out.fillStyle=`rgba(0,0,0,${1-k})`;out.fillRect(0,0,canvas.width,canvas.height);
 out.globalCompositeOperation='lighter';out.globalAlpha=k;out.drawImage(haloStage,0,0);out.globalAlpha=1;out.globalCompositeOperation='source-over';
}
function composeHalo(ctx){
 if(!glowGeom)measureGlow();const g=glowGeom;if(!g){ctx.drawImage(video,0,0,canvas.width,canvas.height);return}
 const {x,y,w,h,vw,vh}=g,W=canvas.width,H=canvas.height,R=x+w,B=y+h;
 ctx.clearRect(0,0,W,H);
 ctx.drawImage(video,x,y,w,h);
 // Smear each edge's pixels outward so the halo lines up with the picture, except where the subject touches
 // that edge: there the smear is the subject itself (Beach girl's face stretched into a grey cloud above the
 // frame, reading as "the fade covers her face"). Fade that side's smear out as the edge locks.
 const keep=k=>{try{return contentAware&&mode==='ambient'?1-Math.min(1,Math.max(0,focus.state.touch?.[k]??0)):1}catch{return 1}};
 const side=(a,fn)=>{if(a<=.01)return;ctx.globalAlpha=a;fn();ctx.globalAlpha=1};
 // a band ~4% deep, not the outermost pixel: one pixel row of foliage flickers as the camera moves
 const dx=Math.max(1,Math.round(vw*.04)),dy=Math.max(1,Math.round(vh*.04));
 if(x>0)side(keep('l'),()=>ctx.drawImage(video,0,0,dx,vh,0,y,x,h));if(R<W)side(keep('r'),()=>ctx.drawImage(video,vw-dx,0,dx,vh,R,y,W-R,h));
 if(y>0)side(keep('t'),()=>ctx.drawImage(video,0,0,vw,dy,x,0,w,y));if(B<H)side(keep('b'),()=>ctx.drawImage(video,0,vh-dy,vw,dy,x,B,w,H-B));
 // corners: the corner pixel itself, faded by both of its sides
 if(x>0&&y>0)side(keep('l')*keep('t'),()=>ctx.drawImage(video,0,0,dx,dy,0,0,x,y));if(R<W&&y>0)side(keep('r')*keep('t'),()=>ctx.drawImage(video,vw-dx,0,dx,dy,R,0,W-R,y));
 if(x>0&&B<H)side(keep('l')*keep('b'),()=>ctx.drawImage(video,0,vh-dy,dx,dy,0,B,x,H-B));if(R<W&&B<H)side(keep('r')*keep('b'),()=>ctx.drawImage(video,vw-dx,vh-dy,dx,dy,R,B,W-R,H-B));
 // Fade the canvas's own border to transparent before the CSS blur. Otherwise, when the halo drifts toward a
 // subject, its round mask isn't transparent at the far edge and the blurred canvas is clipped by the player:
 // a faint vertical line at the player's edge on light backdrops.
 // Also cap how far the smear reaches: it fades out within ~35% of the picture's size beyond each edge. On a tall
 // (phone) player the top/bottom rows were stretched into a long grey column above and below the picture.
 ctx.globalCompositeOperation='destination-in';
 const clamp01=v=>Math.max(0,Math.min(1,v)),reachX=w*.35,reachY=h*.35;
 const gx=ctx.createLinearGradient(0,0,W,0);gx.addColorStop(0,'rgba(0,0,0,0)');gx.addColorStop(clamp01((x-reachX)/W),'rgba(0,0,0,0)');gx.addColorStop(clamp01(x/W),'#000');gx.addColorStop(clamp01(R/W),'#000');gx.addColorStop(clamp01((R+reachX)/W),'rgba(0,0,0,0)');gx.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=gx;ctx.fillRect(0,0,W,H);
 const gy=ctx.createLinearGradient(0,0,0,H);gy.addColorStop(0,'rgba(0,0,0,0)');gy.addColorStop(clamp01((y-reachY)/H),'rgba(0,0,0,0)');gy.addColorStop(clamp01(y/H),'#000');gy.addColorStop(clamp01(B/H),'#000');gy.addColorStop(clamp01((B+reachY)/H),'rgba(0,0,0,0)');gy.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=gy;ctx.fillRect(0,0,W,H);
 ctx.globalCompositeOperation='source-over';
}

const edgeGlow=createEdgeGlow(video,player);canvas.after(edgeGlow.canvas);
function drawEdgeGlow(){if(!ambientOn||mode!=='ambient'||!contentAware){edgeGlow.reset();return}const p=focus.state,f=k=>(lastFade[k]??27.8)/100;edgeGlow.draw(p,{l:f('l'),r:f('r'),t:f('t'),b:f('b')})}
function paint(){if(video.readyState<2||document.hidden||inPip)return;if(ambientOn)try{drawAmbient()}catch{status('Ambient rendering unavailable for this video.')}try{drawEdgeGlow()}catch{}analyzeFocus()}
function frame(now){frameId=undefined;if(video.paused||document.hidden||!(ambientOn||contentAware)||inPip)return;if(now-lastPaint>=(reduced.matches?250:83)){paint();lastPaint=now}frameId=scheduleFrame(frame)}
function startFrames(){stopFrames();if(!video.paused&&!document.hidden&&(ambientOn||contentAware)&&!inPip)frameId=scheduleFrame(frame)}
function settings(open){$('settings').hidden=!open;$('settingsButton').setAttribute('aria-expanded',String(open))}
$('settingsButton').onclick=()=>settings($('settings').hidden);$('closeSettings').onclick=()=>{settings(false);$('settingsButton').focus()};
// Restored from the earlier wide-dissolve version selected by the user.
// Each side reads its own width from a registered CSS property, so the browser can animate it.
function featherMask(axis,start,end){
 const stops=[];
 for(let i=0;i<=10;i++){const t=i/10,alpha=+(t*t*(3-2*t)).toFixed(4);stops.push(`rgba(0,0,0,${alpha}) calc(var(${start}) * ${t})`)}
 for(let i=10;i>=0;i--){const t=i/10,alpha=+(t*t*(3-2*t)).toFixed(4);stops.push(`rgba(0,0,0,${alpha}) calc(100% - var(${end}) * ${t})`)}
 return `linear-gradient(to ${axis},${stops.join(',')})`;
}
// Mask stack (top → bottom): thin 5% feather (y, x) ∩ [ notches ∪ ( soft edge x ∩ soft edge y ) ].
// Notches are soft ellipses around subjects (focus.js), so only the part of an edge near the subject clears;
// the thin feather means even a notch never meets the frame edge as a hard line.
const featherConst=(axis,pct)=>{const st=[];for(let i=0;i<=10;i++){const t=i/10,a=+(t*t*(3-2*t)).toFixed(4);st.push(`rgba(0,0,0,${a}) ${(t*pct).toFixed(3)}%`)}for(let i=10;i>=0;i--){const t=i/10,a=+(t*t*(3-2*t)).toFixed(4);st.push(`rgba(0,0,0,${a}) ${(100-t*pct).toFixed(3)}%`)}return `linear-gradient(to ${axis},${st.join(',')})`};
const notchLayer=i=>`radial-gradient(ellipse var(--n${i}rx) var(--n${i}ry) at var(--n${i}x) var(--n${i}y),rgba(0,0,0,var(--n${i}a)) 0%,rgba(0,0,0,var(--n${i}a)) calc(var(--notch-soft) * 100%),rgba(0,0,0,0) 100%)`;
// Only used when WebGL2 is unavailable: plain soft edges (two layers render reliably on <video>; notch layers didn't).
const filmMask=[featherMask('right','--fade-l','--fade-r'),featherMask('bottom','--fade-t','--fade-b')].join(',');
const filmComposite='intersect,add',filmCompositeWebkit='source-in,source-over';
// The per-layer combine list must be set on the video itself: through a CSS variable Chrome dropped it to all 'add'.
function syncComposite(){if(mode==='ambient'){video.style.webkitMaskComposite=filmCompositeWebkit}else{video.style.webkitMaskComposite=''}}
// Optional reframe (dev panel → Render): zoom the picture a little inside its own frame and pan it away from
// the edge the subject is on, so the subject sits in the clear middle while every fade stays full width.
// Uses object-view-box (Chromium); unsupported browsers just don't offer it.
const canReframe=typeof CSS!=='undefined'&&CSS.supports?.('object-view-box','inset(1% 1% 1% 1%)');let reframe=false,reframeZoom=1.1;
function applyReframe(p){if(!reframe||mode!=='ambient'||!contentAware){video.style.objectViewBox='';gpu?.setView(0,0,1,1);return}if(!canReframe&&!gpu?.on)return;const c=(1-1/reframeZoom)*100;const cl=v=>Math.max(0,Math.min(c,v));const n=p.notches?.[0];const cx=n?n.x:p.cx??.5,cy=n?n.y:p.cy??.5;const l=cl(c/2+(cx-.5)*c*1.6),t=cl(c/2+(cy-.5)*c*1.6);if(gpu?.on){video.style.objectViewBox='';gpu.setView(l/100,t/100,1-c/100,1-c/100)}else video.style.objectViewBox=`inset(${t.toFixed(2)}% ${(c-l).toFixed(2)}% ${(c-t).toFixed(2)}% ${l.toFixed(2)}%)`}
// Content-aware edges: pull the dissolve back on any side where the picture has something to show.
let gpu=null;try{gpu=createGpuFilm(video,player)}catch(e){console.warn('GPU fade unavailable',e)}
const focus=createFocusTracker();const lastFade={};let baseH=27.8,baseV=28.5,analyzeTick=0,contentAware=true;
let debug=new URLSearchParams(location.search).has('debug');let fadeKeep=.93,useFaces=true,dev=null;
// Mirror the player's current settings into the dev panel (called after changes made outside the panel).
function syncDev(){dev?.sync({Player:{scene:$('scene').value,backdrop:$('backdrop').value,softness:+$('softness').value,atmosphere:+$('atmosphere').value,contentAware:$('contentAware').checked},Advanced:{'glow.liveGlow':$('ambientToggle').checked,'render.gpuRenderer':$('gpuFade').checked}})}if(debug)window.__focus=focus;
function applyFocus(s){
 const keep=fadeKeep; // protection 1 (subject touches the edge) keeps 7% of the fade (~2%); a nearby subject tops out at .71 → ~9.5%
 const p=contentAware?s:{l:0,r:0,t:0,b:0,cx:.5,cy:.5};
 const next={l:baseH*(1-keep*p.l),r:baseH*(1-keep*p.r),t:baseV*(1-keep*p.t),b:baseV*(1-keep*p.b)};
 // Performance: with the WebGL renderer on, fades and notches go straight to it (no CSS custom properties).
 // Animating properties on the player forced a style recalc of the whole player and its controls every frame.
 const N=contentAware&&s.notches?s.notches:[];
 applyReframe(p);
 for(const k of ['l','r','t','b'])lastFade[k]=next[k];
 if(gpu?.on)gpu.setFades(next);else for(const k of ['l','r','t','b'])player.style.setProperty(`--fade-${k}`,`${next[k]}%`);
 // Halo centre lives on the halo canvas itself, so its transition only restyles that one element.
 canvas.style.setProperty('--halo-x',`${50+(p.cx-.5)*24}%`);canvas.style.setProperty('--halo-y',`${50+(p.cy-.5)*24}%`);
 // 9 · Controls clearance: when the subject reaches the bottom edge, the control bar gets out of its way while idle.
 const clear=contentAware&&p.b>.6;   // a waist-up body only half-protects the bottom (.5); that shouldn't hide the controls
 if(clear!==player.classList.contains('clear-bottom')){player.classList.toggle('clear-bottom',clear);wake()}
 gpu?.update(N.map(n=>({...n,a:n.a*tuning.notchStrength})),!!(s.cut||s.snap));
 if(debug)drawDebug(s);
}
function analyzeFocus(force){if(!contentAware&&!debug)return;if(!force&&(analyzeTick++%2))return;try{if(useFaces){if(force||!(faceTick++%2))lastFaces=detectFaces(video)}else lastFaces=[];applyFocus(focus.analyze(video,video.currentTime,lastFaces))}catch{}}
// Debug: replay analysis from 0 to t at the normal rate (~6/s) through the real player path, then hold there.
// Debug: emulate slow-motion playback. At playback rate r the player analyses every ~0.167 s of wall-clock
// time, i.e. every r×0.167 s of video, so 0.1x = an analysis every 0.0167 s of video. Continues from where it left off.
let simT=0;
if(debug)window.__paint=()=>{paint()};if(debug)window.__facesReady=facesReady;if(debug)window.__simReset=()=>{simT=0;focus.reset();player.style.transition='none';video.pause()};
if(debug)window.__advanceTo=async(t,rate=.1)=>{const dt=rate*.167;while(simT+dt<=t+1e-6){simT+=dt;await new Promise(r=>{video.addEventListener('seeked',r,{once:true});video.currentTime=Math.min(simT,video.duration-.05)});lastFaces=useFaces?detectFaces(video):[];applyFocus(focus.analyze(video,video.currentTime,lastFaces))}paint();gpu?.pause();const s=focus.state;return `${simT.toFixed(2)}s L${Math.round(lastFade.l)} R${Math.round(lastFade.r)} T${Math.round(lastFade.t)} B${Math.round(lastFade.b)}${s.raw?.faces?' face':''}${player.classList.contains('clear-bottom')?' clear':''}`};
if(debug)window.__stepTo=async t=>{video.pause();focus.reset();player.style.transition='none';for(let x=0;x<=t+1e-3;x+=.17){await new Promise(r=>{video.addEventListener('seeked',r,{once:true});video.currentTime=Math.min(x,video.duration-.05)});lastFaces=useFaces?detectFaces(video):[];applyFocus(focus.analyze(video,video.currentTime,lastFaces))}paint();gpu?.pause();return focus.state};
if(debug)window.__gpu=gpu;if(debug)window.__settle=()=>{for(let i=0;i<25;i++)focus.analyze(video,video.currentTime);applyFocus(focus.state);return focus.state};
// Precomputed Jev focus track for bundled scenes (assets/<scene>.focus.json); local files fall back to live analysis.
let trackRequest=0;
async function loadTrack(src){const id=++trackRequest;focus.setTrack(null);if(!/^assets\/[\w-]+\.mp4$/.test(src))return;try{const r=await fetch(src.replace(/\.mp4$/,'.focus.json'),{cache:'no-cache'});if(r.ok&&id===trackRequest)focus.setTrack(await r.json())}catch{}}
loadTrack(video.getAttribute('src'));
let debugCanvas;let faceTick=0;const detectFacesCached=()=>focus.state.raw?.faces?lastFaces:[];let lastFaces=[];
function drawDebug(s){
 if(!debugCanvas){debugCanvas=document.createElement('canvas');debugCanvas.width=focus.W;debugCanvas.height=focus.H;Object.assign(debugCanvas.style,{position:'fixed',left:'12px',bottom:'12px',width:'240px',height:'135px',imageRendering:'pixelated',zIndex:99,borderRadius:'6px',outline:'1px solid #fff4'});document.body.append(debugCanvas)}
 const c=debugCanvas.getContext('2d'),img=c.createImageData(focus.W,focus.H),m=focus.map;
 for(let i=0;i<m.length;i++){const v=Math.min(255,m[i]*80);img.data.set([v,v*.6,255-v,255],i*4)}
 c.putImageData(img,0,0);const tb=focus.trackBox(video.currentTime);if(tb){c.strokeStyle='#ffd257';c.lineWidth=1;c.strokeRect(tb.left*focus.W,tb.top*focus.H,(tb.right-tb.left)*focus.W,(tb.bottom-tb.top)*focus.H)}for(const f of detectFacesCached()){c.strokeStyle='#ff5ca8';c.strokeRect(f.left*focus.W,f.top*focus.H,(f.right-f.left)*focus.W,(f.bottom-f.top)*focus.H)}c.fillStyle='#fff';c.fillRect(s.cx*focus.W-1,s.cy*focus.H-1,2,2);
 debugCanvas.title=`${focus.track?'Jev track':'live'} · L ${s.l.toFixed(2)} R ${s.r.toFixed(2)} T ${s.t.toFixed(2)} B ${s.b.toFixed(2)}`;
}
function appearance(){const soft=+$('softness').value,atmos=+$('atmosphere').value;player.style.setProperty('--edge',`${soft*.22}%`);player.style.setProperty('--focus-solid',`${Math.max(5,85-soft*.55)}%`);baseH=8+soft*.30;baseV=10+soft*.28;player.style.setProperty('--ambient-film-mask',filmMask);syncComposite();applyFocus(focus.state);player.style.setProperty('--ambient-opacity',atmos/100);$('softValue').value=`${soft}%`;$('atmosValue').value=`${atmos}%`;for(const id of ['softness','atmosphere'])$(id).style.setProperty('--fill',`${$(id).value}%`);paint()}
$('softness').oninput=$('atmosphere').oninput=appearance;
$('ambientToggle').onchange=()=>{ambientOn=$('ambientToggle').checked;canvas.hidden=!ambientOn;paint();startFrames()};$('reset').onclick=()=>{$('softness').value=42;$('atmosphere').value=70;$('ambientToggle').checked=true;$('ambientToggle').onchange();appearance()};
// Changing scene (dropdown, dev panel) or opening a file starts playback once the new video can play; it's muted,
// so browsers allow it.
let autoplayNext=false;
function source(src,title){autoplayNext=true;video.pause();stopFrames();ctx.fillStyle='#171b1f';ctx.fillRect(0,0,canvas.width,canvas.height);glowGeom=null;haloSnap=true;edgeGlow.reset();video.src=src;$('title').textContent=title;video.setAttribute('aria-label',title);focus.reset();clearFaces();loadTrack(src);status('Loading scene…');video.load()}
function load(file){if(!file)return;if(!file.type.startsWith('video/'))return status('Choose a video file.');if(objectURL)URL.revokeObjectURL(objectURL);objectURL=URL.createObjectURL(file);source(objectURL,file.name.replace(/\.[^.]+$/,''));settings(false)}
$('open').onclick=()=>$('file').click();$('file').onchange=e=>{load(e.target.files[0]);e.target.value=''};
let depth=0;player.addEventListener('dragenter',e=>{e.preventDefault();depth++;$('drop').hidden=false});player.addEventListener('dragover',e=>e.preventDefault());player.addEventListener('dragleave',()=>{if(--depth<=0)$('drop').hidden=true});player.addEventListener('drop',e=>{e.preventDefault();depth=0;$('drop').hidden=true;load(e.dataTransfer.files[0])});
video.addEventListener('play',()=>{startFrames();gpu?.play()});video.addEventListener('pause',()=>{stopFrames();gpu?.pause()});video.addEventListener('loadeddata',()=>{paint();analyzeFocus(true);status('');if(autoplayNext){autoplayNext=false;video.muted=true;video.play().catch(()=>{})}});video.addEventListener('seeked',()=>{if(window.__rec)return;haloSnap=true;edgeGlow.reset();paint();analyzeFocus(true);if(video.paused)gpu?.pause();else{gpu?.play();startFrames()}});   // a loop (and scrubbing while playing) is a seek too: pausing the renderer here froze the picture after the first pass
// Autoplay the first scene too (muted, so browsers allow it). Started here, after the play/pause handlers above, so
// the render loop always starts with it; if the video loaded before this line ran, play now.
autoplayNext=true;if(video.readyState>=2){autoplayNext=false;video.muted=true;video.play().catch(()=>{})}
// Backstop: if the browser held autoplay back (or the player library paused during set-up), start the loop as soon as
// the video can play, and on the first click or key press anywhere on the page.
let userPaused=false;video.addEventListener('pause',()=>{if(navigator.userActivation?.isActive)userPaused=true});video.addEventListener('play',()=>{userPaused=false});
const kick=e=>{if(e?.composedPath?.().includes(player))return;   /* clicks on the player go to its own play button */if(video.paused&&!userPaused&&video.readyState>=2){video.muted=true;video.play().catch(()=>{})}};video.addEventListener('canplay',kick);addEventListener('pointerdown',kick,{capture:true});addEventListener('keydown',kick,{capture:true});setTimeout(kick,1500);
const syncGpu=()=>{if(!gpu){$('gpuFade').disabled=true;return}$('gpuFade').disabled=mode!=='ambient';gpu.enable($('gpuFade').checked&&mode==='ambient')};$('gpuFade').onchange=syncGpu;$('contentAware').onchange=()=>{contentAware=$('contentAware').checked;if(contentAware)analyzeFocus(true);else applyFocus(focus.state)};video.addEventListener('waiting',()=>status('Buffering…'));video.addEventListener('playing',()=>status(''));video.addEventListener('error',()=>status('Unable to load this video. Try a local video.'));video.addEventListener('enterpictureinpicture',()=>{inPip=true;stopFrames()});video.addEventListener('leavepictureinpicture',()=>{inPip=false;paint();startFrames()});
document.addEventListener('visibilitychange',()=>document.hidden?stopFrames():(paint(),startFrames()));document.addEventListener('keydown',e=>{if(e.code==='Escape'&&!$('settings').hidden){settings(false);$('settingsButton').focus()}});
window.addEventListener('pagehide',()=>{stopFrames();if(objectURL)URL.revokeObjectURL(objectURL)});
$('backdrop').onchange=e=>{document.body.dataset.backdrop=e.target.value;paint()};
$('scene').onchange=e=>{const key=e.target.value;source(`assets/${key}.mp4`,{marble:'Passing by',chase:'Catch me',beachgirl:'Here I come',balloons:'Up, up and away',rocket:'Blast off',studio:'Crossing white',desert:'Across the sand',dog:'Just passing',redtop:'Evening light',boat:'On the water',beachwalk:'Through the palms',haze:'In the haze',camels:'Across the dunes',balloon:'Drifting up',sailboat:'Under the sun',paraglider:'Over the fields',paddler:'To the island',dream:'Somewhere, between dreams',mountains:'Above the everyday',ocean:'Where the light goes',neon:'After the city sleeps',clouds:'Above the clouds',sunset:'The last light',forest:'A quieter path'}[key]||key)};
video.volume=.7;video.muted=true;appearance();
function fitVideo(){if(!video.videoWidth)return;const surface=player.shadowRoot?.querySelector('.media-container')||player;const dims={ambient:[.82,.79],floating:[.94,.88],cinematic:[.82,.80],focus:[.96,.94],fullscreen:[1,1]}[mode];const scale=(mode==='fullscreen'?Math.max:Math.min)(surface.clientWidth*dims[0]/video.videoWidth,surface.clientHeight*dims[1]/video.videoHeight);video.style.width=`${Math.round(video.videoWidth*scale/2)*2}px`;video.style.height=`${Math.round(video.videoHeight*scale/2)*2}px`;   /* even whole pixels: centred with translate(-50%), the picture lands on the pixel grid instead of blurring across half pixels */glowGeom=null;haloSnap=true;edgeGlow.reset();requestAnimationFrame(()=>{measureGlow();paint();gpu?.resize()})} 
video.addEventListener('loadedmetadata',fitVideo);video.addEventListener('loadedmetadata',()=>{if(video.videoHeight)tuning.aspect=video.videoWidth/video.videoHeight});new ResizeObserver(fitVideo).observe(player);

const modes={
 ambient:{name:'Ambient Fade',number:'01',description:'Soft video edges dissolve into light and color from the same frame.',soft:66,atmos:68},
};
function setMode(next){mode=next;const preset=modes[mode];player.dataset.mode=mode;document.body.dataset.mode=mode;$('modeLabel').textContent=`${preset.number} / ${preset.name.toUpperCase()}`;$('modeDescription').textContent=preset.description;$('expandMode').hidden=mode!=='fullscreen';document.querySelectorAll('.mode-picker button').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.mode===mode)));$('softness').value=preset.soft;$('atmosphere').value=preset.atmos;$('ambientToggle').checked=true;$('ambientToggle').onchange();appearance();fitVideo();wake();syncGpu();syncComposite();syncDev()}
document.querySelectorAll('.mode-picker button').forEach(button=>button.onclick=()=>setMode(button.dataset.mode));
$('reset').onclick=()=>setMode(mode);
$('expandMode').onclick=()=>{const button=player.shadowRoot?.querySelector('media-fullscreen-button');if(button)button.click();else player.requestFullscreen?.().catch(()=>status('Use the fullscreen control in your browser.'))};
let idleTimer;
function wake(){player.classList.remove('mode-idle');clearTimeout(idleTimer);if((mode==='floating'||player.classList.contains('clear-bottom'))&&!video.paused&&$('settings').hidden)idleTimer=setTimeout(()=>{const focused=player.shadowRoot?.activeElement||document.activeElement;if(!focused?.matches?.(':focus-visible'))player.classList.add('mode-idle')},2200)}
player.addEventListener('pointermove',wake);player.addEventListener('pointerdown',wake);player.addEventListener('focusin',wake);player.addEventListener('focusout',()=>setTimeout(wake,0));video.addEventListener('play',wake);video.addEventListener('pause',wake);
await customElements.whenDefined('video-skin');
const modeStyles=document.createElement('style');
modeStyles.textContent=`
:host([data-mode="floating"]) .video-controls-content{inset-inline:8%;max-width:680px;margin-inline:auto;bottom:32px;border-radius:20px;background:rgba(25,32,40,.45)}
:host([data-mode="fullscreen"]) .video-controls-content{background:transparent;box-shadow:none;backdrop-filter:none}
:host([data-mode="fullscreen"]) .video-controls-content:after{box-shadow:none}
:host([data-mode="floating"].mode-idle) .video-controls-content,:host(.clear-bottom.mode-idle) .video-controls-content{opacity:0;pointer-events:none}
:host(.clear-bottom) .video-controls-content{transition:opacity 600ms ease}
.video-controls-content{transition-property:opacity,translate,scale;filter:none}
:host([data-mode="ambient"]) .media-container{background:transparent;border-radius:0;box-shadow:none;border:0}
:host([data-mode="ambient"]) .media-container:after{display:none}
:host([data-mode="ambient"]) .video-controls-backdrop{background:none}
:host([data-mode="ambient"]) .video-controls-content{background:rgba(24,30,38,.7);inset-inline:0;max-width:min(520px,72%);margin-inline:auto;border-radius:999px}
:host([data-mode="ambient"]) .video-controls-content::before,:host([data-mode="ambient"]) .video-controls-content::after{border-radius:999px}
.media-container:fullscreen{width:100vw;height:100dvh}

/* Player popups need their own material; translucent white disappears on a light page. */
.media-skin{
 color-scheme:dark;
 --media-popover:#252b33;--media-popover-foreground:#f7f9fc;
 --media-muted:rgba(255,255,255,.16);--media-muted-foreground:#c6ced8;
 --media-accent:rgba(255,255,255,.14);--media-accent-foreground:#fff;
 --media-border:transparent;--media-frame-border:transparent;
 --media-shadow-surface-inset:none;--media-shadow-tooltip:0 4px 18px #0003;
}
.media-container:after{display:none}
.video-controls-content{box-shadow:0 5px 18px #0002}
.video-controls-content:after,.video-controls-primary:after,.video-controls-secondary:after{box-shadow:none;border:0}
.media-popup-surface,.media-tooltip,.media-menu-content,.media-volume-popover,.media-slider-preview-label{
 color:#f7f9fc;background-color:#252b33;border:0;
 box-shadow:0 6px 24px #0003;text-shadow:none;
 -webkit-backdrop-filter:none;backdrop-filter:none;
}
.media-popup-surface:after{box-shadow:none;border:0}
.media-tooltip-shortcut,.media-menu-item-hint{color:#c6ced8}
.media-menu-item[data-highlighted],.media-menu-radio[data-highlighted]{background:rgba(255,255,255,.14);color:#fff}


@media(prefers-reduced-motion:reduce){.video-controls-content,.video-controls-primary,.video-controls-secondary,.video-controls-backdrop{transition:none!important}}
`;
player.shadowRoot.append(modeStyles);
new ResizeObserver(fitVideo).observe(player.shadowRoot.querySelector('.media-container'));
document.addEventListener('fullscreenchange',fitVideo);
setMode('ambient');

// Keep optional configuration out of the viewing surface.
document.addEventListener('pointerdown',event=>{if(!$('settings').hidden&&!event.composedPath().includes($('settings'))&&!event.composedPath().includes($('settingsButton')))settings(false)});

$('settings').addEventListener('keydown',event=>{event.stopPropagation();if(event.code==='Escape'){settings(false);$('settingsButton').focus()}});

// Scenes come from the clips actually in assets/ (the public repo ships one sample; your own clips show up too).
// Listed scenes without a file are dropped; extra files get their own group, named after the file.
try{const have=new Set(await fetch('/api/scenes').then(r=>r.json())),sel=$('scene'),was=sel.value;
 for(const o of [...sel.options])if(!have.has(o.value)){have.delete(o.value);o.remove()}else have.delete(o.value);
 if(have.size){const g=document.createElement('optgroup');g.label='Your clips';for(const n of have){const o=new Option(n,n);g.append(o)}sel.append(g)}
 for(const g of sel.querySelectorAll('optgroup'))if(!g.children.length)g.remove();
 if(sel.options.length&&sel.value!==was){sel.value=sel.options[0].value;sel.onchange({target:sel})}}catch{}
// Dev panel (devpanel.js, DialKit): docked right, always available. Hooks write into the live player.
dev=mountDevPanel({
 tuning,edgeGlow:edgeGlowSettings,
 scenes:[...$('scene').options].map(o=>({value:o.value,label:o.textContent})),
 current:{scene:$('scene').value,softness:+$('softness').value,atmosphere:+$('atmosphere').value,debug},
 setScene(v){if($('scene').value===v)return;$('scene').value=v;$('scene').onchange({target:$('scene')})},
 setBackdrop(v){$('backdrop').value=v;$('backdrop').onchange({target:$('backdrop')})},
 setSoftness(v){$('softness').value=v;appearance()},
 setAtmosphere(v){$('atmosphere').value=v;appearance()},
 setKeep(v){fadeKeep=v;applyFocus(focus.state)},
 setContentAware(v){$('contentAware').checked=v;$('contentAware').onchange()},
 setLiveGlow(v){$('ambientToggle').checked=v;$('ambientToggle').onchange()},
 setAmbientBlur(v){player.style.setProperty('--ambient-blur',`${v}px`)},
 setEdgeGlowBlur(v){player.style.setProperty('--edge-glow-blur',`${v}px`)},
 setFaces(v){useFaces=v;if(!v)clearFaces();analyzeFocus(true)},
 setDebug(v){debug=v;if(debugCanvas)debugCanvas.style.display=v?'':'none';if(v){window.__focus=focus;analyzeFocus(true)}},
 setGpu(v){$('gpuFade').checked=v;syncGpu()},

 setReframe(v){reframe=v;applyFocus(focus.state)},
 setReframeZoom(v){reframeZoom=v;applyFocus(focus.state)},
 setNotchSoft(v){tuning.notchSoft=v;if(gpu)gpu.soft=v},
 refresh(){analyzeFocus(true);paint()},
 resetTracker(){focus.reset();analyzeFocus(true);paint()},
 restart(){video.currentTime=0;video.play().catch(()=>{})},
 openVideo(){$('file').click()},
});
// The default video can finish loading before the listeners above exist; catch up if so.
if(video.readyState>=2){status('');paint();analyzeFocus(true)}
// Two-way sync: user changes in the ✧ settings (real input/change/click events) update the dev panel.
for(const id of ['softness','atmosphere','scene','backdrop','contentAware','ambientToggle','gpuFade'])$(id).addEventListener(id==='softness'||id==='atmosphere'?'input':'change',()=>queueMicrotask(syncDev));
$('reset').addEventListener('click',()=>queueMicrotask(syncDev));
syncDev();
