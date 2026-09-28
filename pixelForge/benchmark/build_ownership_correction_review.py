#!/usr/bin/env python3
"""Build a self-contained browser editor for ring masks and layer ownership.

Front/back ownership is edited as a binary back-membership mask.  The full
matte supports explicit manual additions and removals, and the front layer is
always derived as ``corrected full - back``.  This prevents contradictory
labels while allowing reviewers to repair genuine matte errors.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import mimetypes
import sys
from pathlib import Path

import cv2

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from benchmark.correction_workflow import (SCHEMA, assign_geometry_holdout,
                                           coverage_summary,
                                           select_manual_decision_cases,
                                           select_representative_cases)


def data_uri(path: Path, mime: str | None = None) -> str:
    mime = mime or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode()}"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


HTML = r'''<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>JewelSense ownership correction</title>
<style>
:root{color-scheme:dark;--zoom:1;font-family:Inter,system-ui,sans-serif}*{box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden}body{margin:0;background:#111;color:#eee;display:flex;flex-direction:column}
header{flex:none;background:#181818;border-bottom:1px solid #444;padding:6px 8px;z-index:5}.row{display:flex;align-items:center;gap:5px;flex-wrap:wrap}.row+.row{margin-top:5px}
button,input,select{font:inherit;color:inherit;background:#292929;border:1px solid #555;border-radius:5px;padding:5px 8px}button{cursor:pointer}button:hover{background:#383838}button.active{background:#365b86;border-color:#83b7ff}.good{border-color:#62cf87}.warn{border-color:#f2b14f}.danger{border-color:#ff7777}
#search{width:185px}.notes{flex:1;min-width:180px}.spacer{flex:1}.progress{white-space:nowrap;font-variant-numeric:tabular-nums}.tool-label{white-space:nowrap;font-size:12px;color:#ccc}#clipboardStatus{max-width:260px;overflow:hidden;text-overflow:ellipsis}.compact{width:105px;padding:0}.brush-size{width:100px;padding:0}
.casebar{flex:none;display:flex;gap:10px;align-items:center;padding:5px 9px;background:#151515;border-bottom:1px solid #333;min-width:0}.casebar strong{white-space:nowrap}.case-meta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#ffc66d}.help{margin-left:auto;color:#bbb;font-size:12px;white-space:nowrap}
.grid{flex:1;min-height:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;padding:0 8px 8px}.panel{min-width:0;min-height:0;display:flex;flex-direction:column}.panel h3{margin:5px 2px 4px;font-size:12px;display:flex;justify-content:space-between}.panel h3 span{font-weight:400;color:#aaa}.viewport{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;border:1px solid #444;border-radius:6px;background:#222;scrollbar-color:#666 #222}.zoomspace{--fit:320px;width:max(100%,calc(var(--fit)*var(--zoom)));height:max(100%,calc(var(--fit)*var(--zoom)));display:flex;align-items:center;justify-content:center}.stage{position:relative;flex:none;width:calc(var(--fit)*var(--zoom));height:calc(var(--fit)*var(--zoom));background:#222}.stage canvas{display:block;width:100%;height:100%;image-rendering:auto}.stage canvas.lasso-overlay{position:absolute;inset:0;pointer-events:none}.editor{cursor:crosshair;touch-action:none}.editor.add{cursor:crosshair}.editor.erase{cursor:cell}.editor.lasso{cursor:crosshair}
.tabs{display:none;flex:none;gap:4px;padding:5px 8px 0}.tabs button{flex:1}.legend{display:inline-flex;gap:8px;font-size:12px}.add-key{color:#62e6a5}.remove-key{color:#ff70bd}
.badge{padding:2px 6px;border-radius:10px;background:#333;font-size:11px}.badge.train{color:#9dd4ff}.badge.holdout{color:#ffcd7c}
#brushCursor{position:fixed;display:none;left:0;top:0;width:20px;height:20px;transform:translate3d(-100px,-100px,0);will-change:transform;border:2px solid #52e89b;border-radius:50%;pointer-events:none;z-index:100;box-shadow:0 0 0 1px #07150d,0 0 5px #000,inset 0 0 0 1px #fff8;background:#52e89b18}
#brushCursor.erase{border-color:#ff64b3;box-shadow:0 0 0 1px #210510,0 0 5px #000,inset 0 0 0 1px #fff8;background:#ff64b318}#brushCursor.remove{border-color:#ffad42;box-shadow:0 0 0 1px #261500,0 0 5px #000,inset 0 0 0 1px #fff8;background:#ffad421d}#brushCursor.restore{border-color:#63c7ff;box-shadow:0 0 0 1px #031724,0 0 5px #000,inset 0 0 0 1px #fff8;background:#63c7ff1d}#brushCursor.fill{border-color:#b789ff;box-shadow:0 0 0 1px #16052b,0 0 5px #000,inset 0 0 0 1px #fff8;background:#b789ff1d}#brushCursor.painting{background:#52e89b38}#brushCursor.erase.painting{background:#ff64b338}#brushCursor.remove.painting{background:#ffad4240}#brushCursor.restore.painting{background:#63c7ff40}#brushCursor.fill.painting{background:#b789ff40}
@media(max-width:1199px){.grid{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr))}}
@media(max-width:720px){header{padding:5px}.hide-small{display:none}#search{flex:1;width:auto}.casebar{padding:4px 6px}.casebar strong{overflow:hidden;text-overflow:ellipsis}.case-meta,.help{display:none}.tabs{display:flex}.grid{display:block;padding:0 6px 6px}.panel{height:100%;display:none}.panel.mobile-active{display:flex}.compact{width:78px}}
@media(max-height:650px){header{padding:4px 6px}.row+.row{margin-top:3px}.casebar{padding-top:3px;padding-bottom:3px}.panel h3{margin-top:3px}}
</style></head>
<body data-bg="dark"><header>
<div class="row"><button id="prev">← Prev</button><button id="next">Next →</button><input id="search" placeholder="Search case/config"><select id="filter"><option value="all">All selected cases</option><option value="unreviewed">Unreviewed</option><option value="draft">Edited drafts</option><option value="ready">Ready labels</option><option value="needs_review">Needs review</option><option value="skip">Skipped</option></select><span class="spacer"></span><span class="tool-label">Zoom</span><button id="zoomOut">−</button><button id="zoomFit">Fit</button><button id="zoomIn">+</button><input id="zoom" class="compact" type="range" min="1" max="5" step=".25" value="1"><output id="zoomValue">100%</output><span id="progress" class="progress"></span></div>
<div class="row"><span class="tool-label">Paint:</span><button id="add" class="active good">B — Add to back</button><button id="erase" class="danger">F — Move to front</button><button id="remove" class="warn">X — Remove from all</button><button id="lasso" class="warn">L — Lasso remove</button><button id="restore">R — Restore removed</button><button id="fill">M — Add missing matte</button><span class="tool-label">Brush radius</span><input id="brush" class="brush-size" type="range" min="2" max="160" value="28"><output id="brushValue">28 px · Ø56</output><button id="undo">Undo</button><button id="redo">Redo</button><button id="copyMask" title="Copy only changes from this case">Copy edits</button><button id="pasteMask" title="Paste copied changes as one undoable operation" disabled>Paste edits</button><span id="clipboardStatus" class="tool-label"></span><button id="reset">Reset mask</button><label class="tool-label"><input id="diff" type="checkbox" checked> show edits</label><span class="hide-small"><button class="bg active" data-bg="dark">Dark</button> <button class="bg" data-bg="checker">Checker</button> <button class="bg" data-bg="white">White</button></span></div>
<div class="row"><button id="ready" class="good">A — Label ready</button><button id="inspect" class="warn">I — Needs review</button><button id="skip" class="danger">S — Skip</button><input id="notes" class="notes" placeholder="Notes for this label"><button id="import">Import JSON</button><input id="file" type="file" accept="application/json" hidden><button id="export">Export corrections JSON</button></div>
</header>
<section class="casebar"><strong id="caseId"></strong><span id="split" class="badge"></span><span id="caseMeta" class="case-meta"></span><span class="help">B/F assigns · X brush remove · L lasso remove · R restores · M adds matte</span></section>
<nav class="tabs"><button data-panel="source" class="active">Source</button><button data-panel="full">Full</button><button data-panel="front">Front</button><button data-panel="back">Back</button></nav>
<main class="grid">
<section class="panel mobile-active" data-panel="source"><h3>Original source <span>fixed input</span></h3><div class="viewport"><div class="zoomspace"><div class="stage"><canvas id="source"></canvas></div></div></div></section>
<section class="panel" data-panel="full"><h3>Full matte <span>paint or lasso mistakes directly</span></h3><div class="viewport"><div class="zoomspace"><div class="stage"><canvas id="full"></canvas><canvas id="fullLasso" class="lasso-overlay"></canvas></div></div></div></section>
<section class="panel" data-panel="front"><h3>Front layer <span>paint or lasso mistakes directly</span></h3><div class="viewport"><div class="zoomspace"><div class="stage"><canvas id="front" class="editor add"></canvas><canvas id="frontLasso" class="lasso-overlay"></canvas></div></div></div></section>
<section class="panel" data-panel="back"><h3>Back layer <span class="legend"><b class="add-key">green = added</b><b class="remove-key">pink = removed</b></span></h3><div class="viewport"><div class="zoomspace"><div class="stage"><canvas id="back" class="editor add"></canvas><canvas id="backLasso" class="lasso-overlay"></canvas></div></div></div></section>
</main>
<div id="brushCursor" aria-hidden="true"></div>
<script>
const CASES=__CASES__, META=__META__, SCHEMA=__SCHEMA__, EXPORT_NAME=__EXPORT_NAME__;
const STORAGE=`jewelsense-corrections:${SCHEMA}:${META.snapshot_id}:${META.runtime_signature}:${META.selection_sha256}`;
const $=id=>document.getElementById(id);let states=JSON.parse(localStorage.getItem(STORAGE)||'{}');let visible=[],pos=0,current=null,loadToken=0,mode='add',undoStack=[],redoStack=[],stroke=null,lastPoint=null,lassoPath=null,editClipboard=null,drawQueued=false,dirtyRect=null,spaceDown=false,pan=null,lastCursor=null,cursorTarget=null,cursorScale=0,cursorDiameter=0;
function save(){try{localStorage.setItem(STORAGE,JSON.stringify(states))}catch(error){alert(`Browser storage is full. Export corrections JSON now.\n${error}`)}updateProgress()}
function encodeRuns(mask){const runs=[];let start=-1;for(let i=0;i<=mask.length;i++){const on=i<mask.length&&mask[i];if(on&&start<0)start=i;else if(!on&&start>=0){runs.push([start,i-start]);start=-1}}return runs}
function decodeRuns(runs,size){const out=new Uint8Array(size);let stop=0;for(const run of runs||[]){const start=Number(run[0]),len=Number(run[1]),end=start+len;if(!Number.isInteger(start)||!Number.isInteger(len)||start<stop||len<=0||end>size)throw new Error('Invalid mask runs');out.fill(1,start,end);stop=end}return out}
function loadPixels(uri){return new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>{const c=document.createElement('canvas');c.width=image.naturalWidth;c.height=image.naturalHeight;const x=c.getContext('2d',{willReadFrequently:true});x.drawImage(image,0,0);resolve({width:c.width,height:c.height,data:x.getImageData(0,0,c.width,c.height).data})};image.onerror=reject;image.src=uri})}
function searchable(c){return `${c.id} ${c.manual_review_status||''} ${JSON.stringify(c.selected)}`.toLowerCase()}
function category(state){if(!state)return'unreviewed';if(state.status==='corrected'||state.status==='approved')return'ready';return state.status||'draft'}
function rebuild(keep){const q=$('search').value.toLowerCase(),f=$('filter').value;visible=CASES.filter(c=>searchable(c).includes(q)&&(f==='all'||category(states[c.id])===f));const at=visible.findIndex(c=>c.id===keep);pos=at>=0?at:Math.min(pos,Math.max(visible.length-1,0));render()}
function statePayload(status){return{status,notes:$('notes').value,source_sha256:current.case.source_sha256,width:current.width,height:current.height,full_runs:encodeRuns(current.support),back_runs:encodeRuns(current.back),split:current.case.split,updated_at:new Date().toISOString()}}
function persistDraft(){if(!current)return;const old=states[current.case.id];states[current.case.id]=statePayload(old?.status&&old.status!=='unreviewed'?old.status:'draft');save()}
function sameMask(){for(let i=0;i<current.back.length;i++)if(current.back[i]!==current.predBack[i]||current.support[i]!==current.predSupport[i])return false;return true}
async function render(){const token=++loadToken;if(!visible.length){$('caseId').textContent='No matching cases';return}const c=visible[pos],s=states[c.id];$('caseId').textContent=`${pos+1}/${visible.length} · ${c.id}`;$('split').textContent=c.split;$('split').className=`badge ${c.split}`;const prior=c.manual_review_status?`manual ${c.manual_review_status} · `:'';$('caseMeta').textContent=prior+Object.entries(c.selected).filter(([k])=>['Center stone shape','Ring head type','Mounting type','Side setting'].includes(k)).map(([,v])=>v).join(' · ');$('notes').value=s?.notes||'';try{const [source,full,back]=await Promise.all([loadPixels(c.source),loadPixels(c.full_mask),loadPixels(c.back_mask)]);if(token!==loadToken)return;if(source.width!==full.width||source.height!==full.height||source.width!==back.width||source.height!==back.height)throw new Error('source/mask dimensions differ');const size=source.width*source.height,fullAlpha=new Uint8Array(size),predSupport=new Uint8Array(size),predBack=new Uint8Array(size);for(let i=0,j=0;i<size;i++,j+=4){fullAlpha[i]=full.data[j];predSupport[i]=full.data[j]>0?1:0;predBack[i]=back.data[j]>0&&predSupport[i]?1:0}let support=predSupport.slice();if(s?.full_runs)support=decodeRuns(s.full_runs,size);for(let i=0;i<size;i++)if(support[i]&&!predSupport[i])fullAlpha[i]=255;let edited=predBack.slice();if(s?.back_runs){edited=decodeRuns(s.back_runs,size)}for(let i=0;i<size;i++)edited[i]&=support[i];current={case:c,width:source.width,height:source.height,source:source.data,fullAlpha,predSupport,support,predBack,back:edited};undoStack=[];redoStack=[];resizeCanvases();drawAll();updateButtons();centrePanels()}catch(error){$('caseMeta').textContent=`Cannot load case: ${error}`}}
function resizeCanvases(){for(const id of['source','full','front','back','fullLasso','frontLasso','backLasso']){const c=$(id);c.width=current.width;c.height=current.height}}
function background(i,w){const kind=document.body.dataset.bg;if(kind==='white')return[255,255,255];if(kind==='checker'){const x=i%w,y=Math.floor(i/w),v=((x>>4)+(y>>4))&1?180:225;return[v,v,v]}return[34,34,34]}
function composite(canvas,which,rect=null){const x0=rect?rect.x0:0,y0=rect?rect.y0:0,x1=rect?rect.x1:current.width-1,y1=rect?rect.y1:current.height-1,w=x1-x0+1,h=y1-y0+1,ctx=canvas.getContext('2d'),out=ctx.createImageData(w,h),showDiff=$('diff').checked;for(let y=y0,j=0;y<=y1;y++)for(let x=x0;x<=x1;x++,j+=4){const i=y*current.width+x,sj=i*4,member=current.support[i]&&(which==='full'||(which==='front'?!current.back[i]:current.back[i]));let a=member?current.fullAlpha[i]/255:0;const bg=background(i,current.width);let r=current.source[sj]*a+bg[0]*(1-a),g=current.source[sj+1]*a+bg[1]*(1-a),b=current.source[sj+2]*a+bg[2]*(1-a);if(which==='full'&&showDiff&&current.predSupport[i]&&!current.support[i]){r=r*.3+175;g=g*.3+85;b=b*.3+10}else if(which==='full'&&showDiff&&!current.predSupport[i]&&current.support[i]){r=r*.3+115;g=g*.3+45;b=b*.3+190}else if(which==='back'&&showDiff&&current.back[i]!==current.predBack[i]){if(current.back[i]){r=r*.35+30;g=g*.35+165;b=b*.35+90}else{r=r*.35+165;g=g*.35+25;b=b*.35+115}}out.data[j]=r;out.data[j+1]=g;out.data[j+2]=b;out.data[j+3]=255}ctx.putImageData(out,x0,y0)}
function drawAll(){if(!current)return;dirtyRect=null;const source=$('source').getContext('2d').createImageData(current.width,current.height);source.data.set(current.source);$('source').getContext('2d').putImageData(source,0,0);composite($('full'),'full');composite($('front'),'front');composite($('back'),'back')}
function includeDirty(x0,y0,x1,y1){const next={x0:Math.max(0,Math.floor(x0)),y0:Math.max(0,Math.floor(y0)),x1:Math.min(current.width-1,Math.ceil(x1)),y1:Math.min(current.height-1,Math.ceil(y1))};if(next.x1<next.x0||next.y1<next.y0)return;if(!dirtyRect)dirtyRect=next;else{dirtyRect.x0=Math.min(dirtyRect.x0,next.x0);dirtyRect.y0=Math.min(dirtyRect.y0,next.y0);dirtyRect.x1=Math.max(dirtyRect.x1,next.x1);dirtyRect.y1=Math.max(dirtyRect.y1,next.y1)}}
function queueDraw(){if(drawQueued)return;drawQueued=true;requestAnimationFrame(()=>{drawQueued=false;const rect=dirtyRect;dirtyRect=null;if(current&&rect){composite($('full'),'full',rect);composite($('front'),'front',rect);composite($('back'),'back',rect)}})}
function point(event,target=event.currentTarget){const rect=target.getBoundingClientRect();return{x:(event.clientX-rect.left)*current.width/rect.width,y:(event.clientY-rect.top)*current.height/rect.height}}
function clearLassoPreview(){for(const id of['fullLasso','frontLasso','backLasso']){const c=$(id);c.getContext('2d').clearRect(0,0,c.width,c.height)}}
function traceLasso(ctx,points){ctx.beginPath();ctx.moveTo(points[0].x,points[0].y);if(points.length===2)ctx.lineTo(points[1].x,points[1].y);else for(let i=1;i<points.length-1;i++){const p=points[i],next=points[i+1];ctx.quadraticCurveTo(p.x,p.y,(p.x+next.x)/2,(p.y+next.y)/2)}ctx.lineTo(points[points.length-1].x,points[points.length-1].y);if(points.length>2)ctx.closePath()}
function appendLassoPoint(p){const points=lassoPath.points,last=points[points.length-1];if(!last||Math.hypot(p.x-last.x,p.y-last.y)>=1.5)points.push(p)}
function drawLassoPreview(){clearLassoPreview();if(!lassoPath||!lassoPath.points.length)return;const c=$(`${lassoPath.target.id}Lasso`),ctx=c.getContext('2d'),points=lassoPath.points;ctx.save();traceLasso(ctx,points);if(points.length>2){ctx.fillStyle='rgba(255,173,66,.16)';ctx.fill()}ctx.strokeStyle='#ffad42';ctx.lineWidth=Math.max(2,current.width/500);ctx.lineJoin='round';ctx.lineCap='round';ctx.setLineDash([8,5]);ctx.stroke();ctx.restore()}
function applyLasso(){const active=lassoPath;lassoPath=null;clearLassoPreview();if(!active||active.points.length<3)return;const points=active.points,x0=Math.max(0,Math.floor(Math.min(...points.map(p=>p.x)))),x1=Math.min(current.width-1,Math.ceil(Math.max(...points.map(p=>p.x)))),y0=Math.max(0,Math.floor(Math.min(...points.map(p=>p.y)))),y1=Math.min(current.height-1,Math.ceil(Math.max(...points.map(p=>p.y)))),mask=document.createElement('canvas');mask.width=current.width;mask.height=current.height;const ctx=mask.getContext('2d',{willReadFrequently:true});traceLasso(ctx,points);ctx.fillStyle='#fff';ctx.fill();const w=x1-x0+1,h=y1-y0+1,pixels=ctx.getImageData(x0,y0,w,h).data;stroke=new Map();for(let y=0;y<h;y++)for(let x=0;x<w;x++){if(pixels[(y*w+x)*4+3]<128)continue;const i=(y0+y)*current.width+x0+x;if(!current.support[i])continue;stroke.set(i,[current.back[i],current.support[i]]);current.support[i]=0;current.back[i]=0}if(stroke.size){includeDirty(x0,y0,x1,y1);queueDraw()}endStroke()}
function updateBrushCursor(event,target=event.currentTarget,forceSize=false){if(!current)return;const cursor=$('brushCursor');if(mode==='lasso'){cursor.style.display='none';lastCursor=null;return}lastCursor={x:event.clientX,y:event.clientY,target};if(forceSize||cursorTarget!==target||!cursorScale){cursorTarget=target;cursorScale=target.getBoundingClientRect().width/current.width}const diameter=Math.max(4,2*Number($('brush').value)*cursorScale);if(forceSize||diameter!==cursorDiameter){cursorDiameter=diameter;cursor.style.width=`${diameter}px`;cursor.style.height=`${diameter}px`}cursor.style.display='block';cursor.style.transform=`translate3d(${event.clientX-diameter/2}px,${event.clientY-diameter/2}px,0)`;cursor.classList.toggle('erase',mode==='erase');cursor.classList.toggle('remove',mode==='remove');cursor.classList.toggle('restore',mode==='restore');cursor.classList.toggle('fill',mode==='fill');cursor.classList.toggle('painting',!!stroke)}
function refreshBrushCursor(forceSize=false){if(lastCursor)updateBrushCursor(lastCursor,lastCursor.target,forceSize)}
function hideBrushCursor(){if(!stroke){$('brushCursor').style.display='none';lastCursor=null;cursorTarget=null;cursorScale=0}}
function paint(x,y){const radius=Number($('brush').value),x0=Math.max(0,Math.floor(x-radius)),x1=Math.min(current.width-1,Math.ceil(x+radius)),y0=Math.max(0,Math.floor(y-radius)),y1=Math.min(current.height-1,Math.ceil(y+radius)),want=mode==='add'?1:0,r2=radius*radius;let changed=false;for(let yy=y0;yy<=y1;yy++)for(let xx=x0;xx<=x1;xx++){if((xx-x)**2+(yy-y)**2>r2)continue;const i=yy*current.width+xx;if(mode==='remove'){if(!current.support[i])continue;if(!stroke.has(i))stroke.set(i,[current.back[i],current.support[i]]);current.support[i]=0;current.back[i]=0;changed=true}else if(mode==='restore'){if(current.support[i]||!current.predSupport[i])continue;if(!stroke.has(i))stroke.set(i,[current.back[i],current.support[i]]);current.support[i]=1;current.back[i]=current.predBack[i];changed=true}else if(mode==='fill'){if(current.support[i]||current.predSupport[i])continue;if(!stroke.has(i))stroke.set(i,[current.back[i],current.support[i]]);current.support[i]=1;current.back[i]=0;current.fullAlpha[i]=255;changed=true}else{if(!current.support[i]||current.back[i]===want)continue;if(!stroke.has(i))stroke.set(i,[current.back[i],current.support[i]]);current.back[i]=want;changed=true}}if(changed){includeDirty(x0,y0,x1,y1);queueDraw()}}
function paintLine(a,b){const radius=Number($('brush').value),distance=Math.hypot(b.x-a.x,b.y-a.y),steps=Math.max(1,Math.ceil(distance/Math.max(radius*.12,.65)));for(let i=1;i<=steps;i++)paint(a.x+(b.x-a.x)*i/steps,a.y+(b.y-a.y)*i/steps)}
function endStroke(){if(!stroke)return;if(stroke.size){const changes=[...stroke].map(([i,[oldBack,oldSupport]])=>[i,oldBack,current.back[i],oldSupport,current.support[i]]);undoStack.push(changes);if(undoStack.length>50)undoStack.shift();redoStack=[];persistDraft()}stroke=null;lastPoint=null;updateButtons()}
function applyChanges(changes,useNew){let x0=current.width,y0=current.height,x1=-1,y1=-1;for(const[i,oldBack,newBack,oldSupport,newSupport]of changes){current.back[i]=useNew?newBack:oldBack;current.support[i]=useNew?newSupport:oldSupport;const x=i%current.width,y=Math.floor(i/current.width);x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y)}if(x1>=0){includeDirty(x0,y0,x1,y1);queueDraw()}persistDraft();updateButtons()}
function copyEdits(){if(!current)return;const edits=[];for(let i=0;i<current.support.length;i++)if(current.support[i]!==current.predSupport[i]||(current.support[i]&&current.back[i]!==current.predBack[i]))edits.push([i,current.support[i],current.back[i]]);if(!edits.length){$('clipboardStatus').textContent='No edits to copy';return}editClipboard={source:current.case.id,width:current.width,height:current.height,edits};$('clipboardStatus').textContent=`Copied ${edits.length.toLocaleString()} px from ${current.case.id}`;updateButtons()}
function pasteEdits(){if(!current||!editClipboard)return;if(current.width!==editClipboard.width||current.height!==editClipboard.height){alert(`Cannot paste ${editClipboard.width}×${editClipboard.height} edits onto ${current.width}×${current.height}.`);return}const changes=[];let x0=current.width,y0=current.height,x1=-1,y1=-1;for(const[i,wantSupport,wantBack]of editClipboard.edits){const oldSupport=current.support[i],oldBack=current.back[i],newSupport=wantSupport?1:0,newBack=newSupport&&wantBack?1:0;if(oldSupport===newSupport&&oldBack===newBack)continue;current.support[i]=newSupport;current.back[i]=newBack;if(newSupport&&!current.predSupport[i])current.fullAlpha[i]=255;changes.push([i,oldBack,newBack,oldSupport,newSupport]);const x=i%current.width,y=Math.floor(i/current.width);x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y)}if(!changes.length){$('clipboardStatus').textContent='Copied edits already match this case';return}undoStack.push(changes);if(undoStack.length>50)undoStack.shift();redoStack=[];includeDirty(x0,y0,x1,y1);queueDraw();persistDraft();$('clipboardStatus').textContent=`Pasted ${changes.length.toLocaleString()} px from ${editClipboard.source}`;updateButtons()}
function updateButtons(){const s=current&&states[current.case.id];for(const id of['ready','inspect','skip'])$(id).classList.toggle('active',id==='ready'?(s?.status==='corrected'||s?.status==='approved'):s?.status===(id==='inspect'?'needs_review':id));$('undo').disabled=!undoStack.length;$('redo').disabled=!redoStack.length;$('pasteMask').disabled=!editClipboard}
function decide(status){if(!current)return;if(status==='ready')status=sameMask()?'approved':'corrected';states[current.case.id]=statePayload(status);save();updateButtons();if($('filter').value!=='all')rebuild();else{pos=Math.min(pos+1,visible.length-1);render()}}
function updateProgress(){const count={approved:0,corrected:0,draft:0,needs_review:0,skip:0};Object.values(states).forEach(s=>{if(count[s.status]!=null)count[s.status]++});$('progress').textContent=`${count.approved+count.corrected}/${CASES.length} ready · ${count.corrected} edited · ${count.draft} draft · ${count.needs_review} inspect`}
function setMode(next){mode=next;$('add').classList.toggle('active',mode==='add');$('erase').classList.toggle('active',mode==='erase');$('remove').classList.toggle('active',mode==='remove');$('lasso').classList.toggle('active',mode==='lasso');$('restore').classList.toggle('active',mode==='restore');$('fill').classList.toggle('active',mode==='fill');$('brush').disabled=mode==='lasso';for(const id of['full','front','back'])$(id).className=`editor ${mode}`;refreshBrushCursor()}
function setZoom(value){value=Math.max(1,Math.min(5,Number(value)));document.documentElement.style.setProperty('--zoom',value);$('zoom').value=value;$('zoomValue').value=`${Math.round(value*100)}%`;centrePanels();requestAnimationFrame(()=>refreshBrushCursor(true))}
function fitPanels(){document.querySelectorAll('.viewport').forEach(v=>v.style.setProperty('--fit',`${Math.max(1,Math.floor(Math.min(v.clientWidth,v.clientHeight)))}px`));centrePanels();requestAnimationFrame(()=>refreshBrushCursor(true))}
function centrePanels(){requestAnimationFrame(()=>document.querySelectorAll('.viewport').forEach(v=>{v.scrollLeft=(v.scrollWidth-v.clientWidth)/2;v.scrollTop=(v.scrollHeight-v.clientHeight)/2}))}
function selectPanel(name){document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('mobile-active',p.dataset.panel===name));document.querySelectorAll('.tabs button').forEach(b=>b.classList.toggle('active',b.dataset.panel===name));requestAnimationFrame(fitPanels)}
function startPaint(e){updateBrushCursor(e);if(spaceDown||e.button===1){const v=e.currentTarget.closest('.viewport');pan={v,x:e.clientX,y:e.clientY,left:v.scrollLeft,top:v.scrollTop};e.currentTarget.setPointerCapture(e.pointerId);return}if(e.button!==0||!current)return;e.currentTarget.setPointerCapture(e.pointerId);if(mode==='lasso'){lassoPath={target:e.currentTarget,points:[]};appendLassoPoint(point(e));drawLassoPreview();return}stroke=new Map();lastPoint=point(e);paint(lastPoint.x,lastPoint.y);updateBrushCursor(e)}
function continuePaint(e){updateBrushCursor(e);if(pan){pan.v.scrollLeft=pan.left-(e.clientX-pan.x);pan.v.scrollTop=pan.top-(e.clientY-pan.y);return}const samples=e.getCoalescedEvents?e.getCoalescedEvents():[e];if(lassoPath){for(const sample of samples)appendLassoPoint(point(sample,e.currentTarget));drawLassoPreview();return}if(!stroke)return;for(const sample of samples){const p=point(sample,e.currentTarget);paintLine(lastPoint,p);lastPoint=p}updateBrushCursor(e)}
function finishPaint(e){pan=null;if(lassoPath){if(e)appendLassoPoint(point(e,e.currentTarget));applyLasso();return}endStroke();if(e)updateBrushCursor(e)}
function cancelPaint(){pan=null;if(lassoPath){lassoPath=null;clearLassoPreview()}endStroke()}
for(const id of['full','front','back']){$(id).onpointerenter=updateBrushCursor;$(id).onpointerdown=startPaint;$(id).onpointermove=continuePaint;$(id).onpointerup=finishPaint;$(id).onpointercancel=cancelPaint;$(id).onpointerleave=hideBrushCursor}
$('undo').onclick=()=>{if(!undoStack.length)return;const c=undoStack.pop();redoStack.push(c);applyChanges(c,false)};$('redo').onclick=()=>{if(!redoStack.length)return;const c=redoStack.pop();undoStack.push(c);applyChanges(c,true)};$('copyMask').onclick=copyEdits;$('pasteMask').onclick=pasteEdits;$('reset').onclick=()=>{if(!current)return;const changes=[];for(let i=0;i<current.back.length;i++)if(current.back[i]!==current.predBack[i]||current.support[i]!==current.predSupport[i])changes.push([i,current.back[i],current.predBack[i],current.support[i],current.predSupport[i]]);if(changes.length){undoStack.push(changes);redoStack=[];applyChanges(changes,true)}};
$('prev').onclick=()=>{pos=Math.max(0,pos-1);render()};$('next').onclick=()=>{pos=Math.min(visible.length-1,pos+1);render()};$('search').oninput=()=>rebuild(current?.case.id);$('filter').onchange=()=>rebuild();$('add').onclick=()=>setMode('add');$('erase').onclick=()=>setMode('erase');$('remove').onclick=()=>setMode('remove');$('lasso').onclick=()=>setMode('lasso');$('restore').onclick=()=>setMode('restore');$('fill').onclick=()=>setMode('fill');$('brush').oninput=e=>{const radius=Number(e.target.value);$('brushValue').value=`${radius} px · Ø${radius*2}`;refreshBrushCursor(true)};$('diff').onchange=drawAll;$('ready').onclick=()=>decide('ready');$('inspect').onclick=()=>decide('needs_review');$('skip').onclick=()=>decide('skip');$('notes').onchange=()=>{if(current)persistDraft()};
$('zoom').oninput=e=>setZoom(e.target.value);$('zoomOut').onclick=()=>setZoom(Number($('zoom').value)-.25);$('zoomFit').onclick=()=>setZoom(1);$('zoomIn').onclick=()=>setZoom(Number($('zoom').value)+.25);document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>selectPanel(b.dataset.panel));document.querySelectorAll('.bg').forEach(b=>b.onclick=()=>{document.body.dataset.bg=b.dataset.bg;document.querySelectorAll('.bg').forEach(x=>x.classList.toggle('active',x===b));drawAll()});
$('export').onclick=()=>{const payload={schema:SCHEMA,snapshot_id:META.snapshot_id,runtime_signature:META.runtime_signature,source_report_sha256:META.source_report_sha256,selection_sha256:META.selection_sha256,exported_at:new Date().toISOString(),cases:states};const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=EXPORT_NAME;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)};$('import').onclick=()=>$('file').click();$('file').onchange=async e=>{try{const payload=JSON.parse(await e.target.files[0].text());if(payload.schema!==SCHEMA||payload.snapshot_id!==META.snapshot_id||payload.runtime_signature!==META.runtime_signature||payload.selection_sha256!==META.selection_sha256)throw new Error('Correction file belongs to a different snapshot, runtime, or selection');states=payload.cases||{};save();rebuild(current?.case.id)}catch(error){alert(`Import failed: ${error.message}`)}e.target.value=''};
document.onkeydown=e=>{if(['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName))return;const key=e.key.toLowerCase();if((e.ctrlKey||e.metaKey)&&key==='c'){e.preventDefault();copyEdits();return}if((e.ctrlKey||e.metaKey)&&key==='v'){e.preventDefault();pasteEdits();return}if(e.code==='Space'){spaceDown=true;e.preventDefault()}if(e.key==='ArrowLeft')$('prev').click();if(e.key==='ArrowRight')$('next').click();if(key==='b')setMode('add');if(key==='f')setMode('erase');if(key==='x')setMode('remove');if(key==='l')setMode('lasso');if(key==='r')setMode('restore');if(key==='m')setMode('fill');if(key==='a')$('ready').click();if(key==='i')$('inspect').click();if(e.key==='['||e.key===']'){const delta=e.key==='['?-4:4;$('brush').value=Math.max(2,Math.min(160,Number($('brush').value)+delta));$('brush').dispatchEvent(new Event('input'))}if((e.ctrlKey||e.metaKey)&&key==='z'){e.preventDefault();e.shiftKey?$('redo').click():$('undo').click()}if(e.key==='+'||e.key==='=')$('zoomIn').click();if(e.key==='-')$('zoomOut').click();if(e.key==='0')$('zoomFit').click()};document.onkeyup=e=>{if(e.code==='Space')spaceDown=false};
new ResizeObserver(fitPanels).observe(document.querySelector('.grid'));setMode('add');setZoom(1);rebuild();fitPanels();updateProgress();
</script></body></html>'''


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", required=True)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--budget", type=int, default=72)
    parser.add_argument("--holdout", type=int, default=16)
    parser.add_argument(
        "--manual-decisions",
        help="select exact cases from a manual benchmark decision export",
    )
    parser.add_argument(
        "--decision-statuses", nargs="+", default=("rejected", "inspect"),
        help="manual statuses to include, in correction-review order",
    )
    parser.add_argument("--export-name", default="ownership-corrections.json")
    return parser.parse_args()


def main():
    args = parse_args()
    report_path = Path(args.report).resolve()
    snapshot_path = Path(args.snapshot).resolve()
    output_path = Path(args.out).resolve()
    output_path.mkdir(parents=True, exist_ok=True)
    report = json.loads(report_path.read_text())
    decision_path = Path(args.manual_decisions).resolve() if args.manual_decisions else None
    if decision_path:
        decision_export = json.loads(decision_path.read_text())
        selected = select_manual_decision_cases(
            report, decision_export, args.decision_statuses
        )
        selection_method = (
            "exact cases marked " + ", then ".join(args.decision_statuses)
            + " in the bound full-benchmark manual review"
        )
    else:
        selected = select_representative_cases(report, args.budget)
        selection_method = (
            "mandatory known defects plus deterministic weighted control-value "
            "and geometry-pair coverage"
        )
    split = assign_geometry_holdout(selected, args.holdout)
    result_path = report_path.parent

    browser_cases = []
    selection_cases = []
    for index, case in enumerate(selected):
        source_path = snapshot_path / case["source_file"]
        full_path = result_path / case["masks"]["full"]
        back_path = result_path / case["masks"]["back"]
        source = cv2.imread(str(source_path), cv2.IMREAD_COLOR)
        full = cv2.imread(str(full_path), cv2.IMREAD_GRAYSCALE)
        back = cv2.imread(str(back_path), cv2.IMREAD_GRAYSCALE)
        if source is None or full is None or back is None:
            raise ValueError(f"missing source or masks for {case['id']}")
        if source.shape[:2] != full.shape or full.shape != back.shape:
            raise ValueError(f"source/mask dimensions differ for {case['id']}")
        record = {
            "index": index,
            "id": case["id"],
            "source_sha256": case["source_sha256"],
            "split": split[case["id"]],
            "selected": case.get("selected", {}),
            "metrics": case.get("metrics", {}),
        }
        if case.get("manual_review_status"):
            record["manual_review_status"] = case["manual_review_status"]
        selection_cases.append(record)
        browser_cases.append({
            **record,
            "source": data_uri(source_path),
            "full_mask": data_uri(full_path, "image/png"),
            "back_mask": data_uri(back_path, "image/png"),
        })

    manifest = {
        "schema_version": 1,
        "purpose": "manual semantic front/back ownership annotation",
        "snapshot_id": report["snapshot_id"],
        "runtime_signature": report["runtime"]["signature"],
        "source_report": str(report_path),
        "source_report_sha256": sha256(report_path),
        "budget": len(selected),
        "holdout_cases": args.holdout,
        "selection_method": selection_method,
        "coverage": coverage_summary(selected),
        "cases": selection_cases,
    }
    if decision_path:
        manifest["manual_decisions"] = str(decision_path)
        manifest["manual_decisions_sha256"] = sha256(decision_path)
        manifest["manual_decision_statuses"] = list(args.decision_statuses)
    manifest_path = output_path / "selection_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    manifest_sha = sha256(manifest_path)
    metadata = {
        "snapshot_id": report["snapshot_id"],
        "runtime_signature": report["runtime"]["signature"],
        "source_report_sha256": manifest["source_report_sha256"],
        "selection_sha256": manifest_sha,
    }
    html = (HTML.replace("__CASES__", json.dumps(browser_cases, separators=(",", ":")))
            .replace("__META__", json.dumps(metadata, separators=(",", ":")))
            .replace("__SCHEMA__", json.dumps(SCHEMA))
            .replace("__EXPORT_NAME__", json.dumps(args.export_name)))
    html_path = output_path / "ownership_correction_review.html"
    html_path.write_text(html)
    print(html_path)
    print(manifest_path)
    print(f"selected={len(selected)} train={len(selected)-args.holdout} holdout={args.holdout}")


if __name__ == "__main__":
    main()
