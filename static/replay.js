(function(root){
 'use strict';
 class ReplayController {
  constructor({steps=0,onChange=()=>{},canPlay=()=>true,setTimer=(fn,ms)=>setTimeout(fn,ms),clearTimer=id=>clearTimeout(id)}={}){
   Object.assign(this,{steps,step:0,speed:1,loop:true,playing:false,timer:null,onChange,canPlay,setTimer,clearTimer});
  }
  cancel(){if(this.timer!==null)this.clearTimer(this.timer);this.timer=null;}
  emit(){this.onChange(this);}
  schedule(){
   this.cancel();if(!this.playing)return;
   this.timer=this.setTimer(()=>{
    this.timer=null;
    if(!this.canPlay()){this.pause();return;}
    if(this.step>=this.steps){
     if(!this.loop){this.pause();return;}
     this.step=0;
    }else this.step++;
    if(this.step===this.steps&&!this.loop)this.playing=false;
    this.emit();this.schedule();
   },this.step===this.steps?2000:500/this.speed);
  }
  play(){
   if(this.playing||!this.steps||!this.canPlay())return;
   if(this.step===this.steps)this.step=0;
   this.playing=true;this.emit();this.schedule();
  }
  pause(){this.cancel();this.playing=false;this.emit();}
  seek(step){this.cancel();this.playing=false;this.step=Math.max(0,Math.min(this.steps,Math.round(Number(step)||0)));this.emit();}
  restart(){this.seek(0);this.play();}
  setSpeed(speed){if(![0.5,1,2,4].includes(Number(speed)))return;this.speed=Number(speed);this.emit();this.schedule();}
  setLoop(loop){this.loop=Boolean(loop);if(!this.loop&&this.step===this.steps)this.pause();else this.emit();}
  reset(steps){this.cancel();this.playing=false;this.steps=Math.max(0,steps);this.step=0;this.emit();}
 }
 function clock(step,dt){const minutes=Math.round(step*dt*60);return String(Math.floor(minutes/60)).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0');}
 // Return plotting points without changing source data. Interval averages are
 // horizontal steps; state samples and end-of-interval PMV retain their times.
 function points(series,until=Infinity){
  const out=[],offset=series.offset||0;
  for(let k=0;k<series.values.length;k++){
   const t=k+offset;if(t>until)break;
   out.push([t,series.values[k]]);
   if(series.interval)out.push([Math.min(t+1,until),series.values[k]]);
  }
  return out;
 }
 const api={ReplayController,clock,points};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;
 else root.RCVBReplay=api;
})(typeof window==='undefined'?this:window);
