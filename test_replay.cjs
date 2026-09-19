const assert=require('node:assert/strict');
const {test}=require('node:test');
const {ReplayController,clock,points}=require('./static/replay.js');
const fs=require('node:fs');
const vm=require('node:vm');
function harness(){
 let now=0,id=0,active=true;const timers=new Map(),frames=[];
 const controller=new ReplayController({steps:96,canPlay:()=>active,onChange:r=>frames.push({step:r.step,playing:r.playing}),setTimer:(fn,delay)=>{timers.set(++id,{fn,at:now+delay});return id;},clearTimer:id=>timers.delete(id)});
 function advance(ms){const end=now+ms;while(timers.size){const [id,event]=[...timers.entries()].sort((a,b)=>a[1].at-b[1].at)[0];if(event.at>end)break;now=event.at;timers.delete(id);event.fn();}now=end;}
 return {controller,advance,timers,frames,setActive:v=>active=v};
}
test('24h playback takes 48s, holds the final frame for 2s, then loops',()=>{
 const {controller:r,advance}=harness();r.play();advance(48000);assert.equal(r.step,96);assert.equal(r.playing,true);advance(1999);assert.equal(r.step,96);advance(1);assert.equal(r.step,0);advance(500);assert.equal(r.step,1);
});
test('pause, seek, stepping and restart cancel pending callbacks',()=>{
 const {controller:r,advance,timers}=harness();r.play();r.play();assert.equal(timers.size,1);advance(1000);r.pause();advance(10000);assert.equal(r.step,2);r.seek(48);assert.equal(r.playing,false);assert.equal(timers.size,0);r.seek(-1);assert.equal(r.step,0);r.seek(120);assert.equal(r.step,96);r.restart();assert.equal(r.step,0);assert.equal(r.playing,true);
});
test('speed changes reschedule once; non-looping playback stops at the endpoint',()=>{
 const {controller:r,advance,timers}=harness();r.setLoop(false);r.setSpeed(4);r.play();advance(12000);assert.equal(r.step,96);assert.equal(r.playing,false);assert.equal(timers.size,0);r.play();assert.equal(r.step,0);r.setSpeed(2);assert.equal(timers.size,1);advance(250);assert.equal(r.step,1);r.setSpeed(0);assert.equal(r.speed,2);
});
test('leaving the view or hiding the document prevents further playback',()=>{
 const {controller:r,advance,setActive,timers}=harness();r.play();setActive(false);advance(500);assert.equal(r.step,0);assert.equal(r.playing,false);assert.equal(timers.size,0);r.play();assert.equal(r.playing,false);setActive(true);r.play();advance(500);assert.equal(r.step,1);r.reset(0);r.play();assert.equal(r.playing,false);
});
test('switching loop off during the final hold stops immediately',()=>{
 const {controller:r,advance,timers}=harness();r.play();advance(48000);r.setLoop(false);assert.equal(r.playing,false);assert.equal(timers.size,0);advance(3000);assert.equal(r.step,96);
});
test('browser timer functions are not called with the controller as receiver',()=>{
 const sandbox={window:{},setTimeout:function(){assert.equal(this?.steps,undefined);return 1;},clearTimeout:function(){assert.equal(this?.steps,undefined);}};
 vm.createContext(sandbox);vm.runInContext(fs.readFileSync('static/replay.js','utf8'),sandbox);
 vm.runInContext('const r=new window.RCVBReplay.ReplayController({steps:96});r.play();r.pause();',sandbox);
});
test('power intervals, boundary states and end-of-interval PMV align without future leakage',()=>{
 const result=require('./data/api.json')['/api/demo-result'].rolling;
 assert.equal(result.T.length,97);assert.equal(result.H.length,96);assert.equal(result.pmv_series.length,96);
 const original=JSON.stringify(result);
 for(const k of [0,1,32,48,95,96]){
  const temp=points({values:result.T},k);assert.equal(temp.at(-1)[0],k);assert.equal(temp.at(-1)[1],result.T[k]);
  const power=points({values:result.H,interval:true},k);assert.equal(power.at(-1)[0],k);assert.equal(power.at(-1)[1],result.H[Math.min(k,95)]);
  const pmv=points({values:result.pmv_series,offset:1},k);assert.equal(pmv.length,k);assert(pmv.every(([t])=>t<=k));
 }
 assert.equal(clock(0,.25),'00:00');assert.equal(clock(33,.25),'08:15');assert.equal(clock(96,.25),'24:00');assert.equal(JSON.stringify(result),original);
});
test('chart axes stay fixed and legend styles match at every playback position',()=>{
 const html=fs.readFileSync('static/index.html','utf8');
 new vm.Script(html.match(/<script>'use strict';([\s\S]*?)<\/script>/)[1]);
 const chartSource=html.slice(html.indexOf('function chart('),html.indexOf('const replayPanel='));
 let expectedAxis;
 for(const cursor of [0,48,96]){
  const labels=[],strokes=[],stack=[];const ctx={strokeStyle:'',lineWidth:1,dash:[],path:[],scale(){},clearRect(){},fillRect(){},fill(){},arc(){},beginPath(){this.path=[];},moveTo(x,y){this.path.push([x,y]);},lineTo(x,y){this.path.push([x,y]);},fillText(text,x,y){labels.push([text,x,y]);},setLineDash(v){this.dash=[...v];},stroke(){strokes.push({color:this.strokeStyle,width:this.lineWidth,dash:[...this.dash]});},save(){stack.push({strokeStyle:this.strokeStyle,lineWidth:this.lineWidth,dash:[...this.dash]});},restore(){Object.assign(this,stack.pop());}};
  const sandbox={$:()=>({clientWidth:340,clientHeight:250,getContext:()=>ctx}),window:{devicePixelRatio:2},palette:['blue','orange'],RCVBReplay:{points,clock}};
  vm.createContext(sandbox);vm.runInContext(chartSource,sandbox);
  sandbox.chart('test',[{name:'state',values:Array.from({length:97},(_,i)=>24+i/96),history:true},{name:'bound',values:Array(96).fill(27),interval:true,thin:true,color:'purple'}],.25,{steps:96,cursor,windowSteps:16});
  const axes=labels.slice(1,11);if(expectedAxis)assert.deepEqual(axes,expectedAxis);else expectedAxis=axes;
  assert.deepEqual(strokes[5],strokes[6]);assert.deepEqual(strokes[7],strokes[8]);assert.deepEqual(strokes[7],{color:'purple',width:1.5,dash:[6,4]});
 }
});
