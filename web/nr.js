/* VoiceCut on-device spectral noise reduction (NR-1).
 * 100% offline: no upload, no server, no keys, no network needed.
 * Method: STFT adaptive spectral gating with smoothed gains,
 * plus a second-order rumble highpass (static filter for the wandering lows, adaptive gate for the rest). Tuned for voice over steady noise
 * (fan, AC, engine rumble, hum, hiss). Sudden sounds (page turns, claps)
 * are reduced, not erased; background speech is preserved by design.
 * Works on any buffer-like object with numberOfChannels/length/sampleRate
 * and getChannelData(); output is built via the createBuffer factory so the
 * same code runs in browsers (AudioBuffer) and in Node tests (memory shim).
 */
(function(root){
'use strict';
var LEVELS={
  light:{frame:2048,thresh:1.3,floor:0.30,attack:0.70,release:0.10,smooth:1,hp:60},
  medium:{frame:2048,thresh:1.8,floor:0.15,attack:0.60,release:0.07,smooth:2,hp:80},
  strong:{frame:2048,thresh:2.5,floor:0.06,attack:0.50,release:0.05,smooth:3,hp:110},
  voicefocus:{frame:2048,thresh:4.5,floor:0.01,attack:0.25,release:0.15,smooth:2,hp:140},
  ultra:{frame:2048,thresh:6.0,floor:0.002,attack:0.10,release:0.35,smooth:3,hp:160}
};
function makeFFT(n){
  var levels=Math.round(Math.log2(n));
  if((1<<levels)!==n)throw new Error('FFT size must be a power of two');
  var cosT=new Float32Array(n/2),sinT=new Float32Array(n/2),i;
  for(i=0;i<n/2;i++){cosT[i]=Math.cos(2*Math.PI*i/n);sinT[i]=Math.sin(2*Math.PI*i/n);}
  function transform(re,im,inverse){
    var j=0,i,bit,t;
    for(i=1;i<n;i++){bit=n>>1;for(;j>=bit;bit>>=1)j-=bit;j+=bit;if(i<j){t=re[i];re[i]=re[j];re[j]=t;t=im[i];im[i]=im[j];im[j]=t;}}
    var size,half,tabStep,a,b,k,tt,c,s,tr,ti;
    for(size=2;size<=n;size<<=1){
      half=size>>1;tabStep=n/size;
      for(i=0;i<n;i+=size)for(k=0;k<half;k++){
        a=i+k;b=a+half;tt=tabStep*k;
        c=cosT[tt];s=inverse?-sinT[tt]:sinT[tt];
        tr=re[b]*c-im[b]*s;ti=re[b]*s+im[b]*c;
        re[b]=re[a]-tr;im[b]=im[a]-ti;re[a]+=tr;im[a]+=ti;
      }
    }
    if(inverse)for(i=0;i<n;i++){re[i]/=n;im[i]/=n;}
  }
  return{forward:function(re,im){transform(re,im,false);},inverse:function(re,im){transform(re,im,true);}};
}
async function spectralDenoise(buffer,level,onProgress,createBuffer,isCancelled){
  var cfg=LEVELS[level]||LEVELS.medium;
  var sr=buffer.sampleRate|0,ch=Math.max(1,buffer.numberOfChannels|0),len=buffer.length|0;
  if(!(sr>0)||!(len>0))throw new Error('Empty audio.');
  if(typeof createBuffer!=='function')throw new Error('Output buffer factory missing.');
  var N=cfg.frame,hop=N>>1,bins=(N>>1)+1,c,i;
  var fft=makeFFT(N);
  var win=new Float32Array(N);
  for(i=0;i<N;i++)win[i]=Math.sqrt(0.5-0.5*Math.cos(2*Math.PI*i/N));
  var prog=typeof onProgress==='function'?onProgress:function(){};
  var cancelled=typeof isCancelled==='function'?isCancelled:function(){return false;};
  function tick(){return new Promise(function(r){setTimeout(r,0);});}
  var inCh=[];for(c=0;c<ch;c++)inCh.push(buffer.getChannelData(c));
  /* Prime the noise profile from the quietest half-second (mono RMS scan),
     so clips that start with speech are not learned as noise. */
  var block=Math.max(256,(sr/20)|0),bestStart=0,bestMean=Infinity,b,nBlocks;
  nBlocks=Math.max(1,(len/block)|0);
  for(b=0;b<nBlocks;b++){
    var s0=b*block,s1=Math.min(len,s0+block),acc=0,n=0;
    for(c=0;c<ch;c++){var d=inCh[c];for(i=s0;i<s1;i+=7){acc+=d[i]*d[i];n++;}}
    var mean=n?acc/n:0;
    if(mean<bestMean){bestMean=mean;bestStart=s0;}
  }
  var est=new Float32Array(bins);var accP=new Float32Array(bins),primeN=0;
  (function prime(){
    var re=new Float32Array(N),im=new Float32Array(N),f,bb;
    var span=Math.min(len-bestStart,sr>>1);
    var primeFrames=Math.min(24,Math.max(1,Math.ceil(span/Math.max(1,hop))));
    for(f=0;f<primeFrames;f++){
      var s=bestStart+f*hop;
      for(i=0;i<N;i++){var p=s+i,v=0;if(p>=0&&p<len)for(c=0;c<ch;c++)v+=inCh[c][p];re[i]=v/ch*win[i];im[i]=0;}
      fft.forward(re,im);
      for(bb=0;bb<bins;bb++){accP[bb]+=Math.sqrt(re[bb]*re[bb]+im[bb]*im[bb]);}
      primeN++;
    }
    for(bb=0;bb<bins;bb++)est[bb]=primeN>0?accP[bb]/primeN:0;
  })();
  /* Chunked processing with carried state (highpass, noise profile, gains,
     overlap-add tail) so long clips stay within mobile memory limits. */
  var CHUNK=Math.max(N*4,sr*30);
  var out=[];for(c=0;c<ch;c++)out.push(new Float32Array(len));
  var tail=[];for(c=0;c<ch;c++)tail.push(new Float32Array(hop));
  var hpW0=2*Math.PI*cfg.hp/sr,hpCos=Math.cos(hpW0),hpSin=Math.sin(hpW0),hpAlpha=hpSin/(2*0.707);
  var hb0=(1+hpCos)/2,hb1=-(1+hpCos),hb2=(1+hpCos)/2,ha0=1+hpAlpha,ha1=-2*hpCos,ha2=1-hpAlpha;
  hb0/=ha0;hb1/=ha0;hb2/=ha0;ha1/=ha0;ha2/=ha0;
  var fX1=new Float64Array(ch),fX2=new Float64Array(ch),fY1=new Float64Array(ch),fY2=new Float64Array(ch);
  var gainArr=new Float32Array(bins).fill(1);
  var sm=new Float32Array(bins);
  var reM=new Float32Array(N),imM=new Float32Array(N);var magB=new Float32Array(bins),hotStreak=0;
  var reC=new Float32Array(N),imC=new Float32Array(N);
  var framesDone=0,totalFrames=Math.max(1,Math.ceil(len/hop)),R=cfg.smooth;
  var cStart,cEnd,a,hd,hdArr,firstFrame,k,s,bb,jj,aa,nn,g,target,mm,e,above,bb2;
  for(cStart=0;cStart<len;cStart+=CHUNK){
    if(cancelled())throw new Error('Cancelled');
    cEnd=Math.min(len,cStart+CHUNK);
    var accArr=[];
    for(c=0;c<ch;c++){a=new Float32Array((cEnd-cStart)+2*hop);a.set(tail[c],0);accArr.push(a);}
    hdArr=[];
    for(c=0;c<ch;c++){
      var src=inCh[c];hd=new Float32Array(cEnd-cStart);
      var x1=fX1[c],x2=fX2[c],y1=fY1[c],y2=fY2[c];
      for(i=0;i<hd.length;i++){var v=src[cStart+i];var y=hb0*v+hb1*x1+hb2*x2-ha1*y1-ha2*y2;x2=x1;x1=v;y2=y1;y1=y;hd[i]=y;}
      fX1[c]=x1;fX2[c]=x2;fY1[c]=y1;fY2[c]=y2;hdArr.push(hd);
    }
    firstFrame=Math.max(0,Math.ceil(cStart/hop));
    for(k=firstFrame;k*hop<cEnd;k++){
      s=k*hop;
      for(i=0;i<N;i++){var p=s+i,vv2=0;if(p>=cStart&&p<cEnd)for(c=0;c<ch;c++)vv2+=hdArr[c][p-cStart];reM[i]=vv2/ch*win[i];imM[i]=0;}
      fft.forward(reM,imM);
      above=0;
      for(bb=0;bb<bins;bb++){
        mm=Math.sqrt(reM[bb]*reM[bb]+imM[bb]*imM[bb]);
        magB[bb]=mm;
        e=est[bb];
        if(mm<e*cfg.thresh){e+=(mm-e)*0.05;}else{e+=(mm-e)*0.002;above++;}
        est[bb]=e;
        target=mm>e*cfg.thresh?1:cfg.floor;
        g=gainArr[bb];
        gainArr[bb]=g+(target-g)*(target>g?cfg.attack:cfg.release);
      }
      /* Broadband escape: speech is sparse, so >75% hot bins for 3 frames in a
         row means the noise model is stuck far too low (e.g. bad prime on
         wandering noise). Jump the model to the current frame to recover. */
      if(above/bins>0.75){hotStreak++;}else{hotStreak=0;}
      if(hotStreak>=3){for(bb2=0;bb2<bins;bb2++)est[bb2]+=(magB[bb2]-est[bb2])*0.5;hotStreak=0;}
      for(bb=0;bb<bins;bb++){aa=0;nn=0;for(jj=bb-R;jj<=bb+R;jj++)if(jj>=0&&jj<bins){aa+=gainArr[jj];nn++;}sm[bb]=aa/nn;}
      for(c=0;c<ch;c++){
        hd=hdArr[c];
        for(i=0;i<N;i++){var pp=s+i;reC[i]=(pp>=cStart&&pp<cEnd?hd[pp-cStart]:0)*win[i];imC[i]=0;}
        fft.forward(reC,imC);
        for(bb=0;bb<bins;bb++){reC[bb]*=sm[bb];imC[bb]*=sm[bb];}
        for(bb=bins;bb<N;bb++){var mb=N-bb;reC[bb]*=sm[mb];imC[bb]*=sm[mb];}
        fft.inverse(reC,imC);
        a=accArr[c];
        var off=s-cStart+hop;
        for(i=0;i<N;i++){var q=off+i;if(q>=0&&q<a.length)a[q]+=reC[i]*win[i];}
      }
      framesDone++;
      if(framesDone%25===0){prog(Math.min(99,Math.round(framesDone/totalFrames*100)),'Reducing noise on this device');await tick();}
    }
    for(c=0;c<ch;c++){out[c].set(accArr[c].subarray(hop,hop+(cEnd-cStart)),cStart);tail[c].set(accArr[c].subarray(hop+(cEnd-cStart),hop+(cEnd-cStart)+hop));}
    prog(Math.min(99,Math.round(cEnd/len*100)),'Reducing noise on this device');
    await tick();
  }
  var result=createBuffer(ch,len,sr);
  for(c=0;c<ch;c++)result.copyToChannel(out[c],c);
  prog(100,'Noise reduced on this device');
  return result;
}
root.VoiceCutNR={spectralDenoise:spectralDenoise,LEVELS:LEVELS,version:'1.0.0'};
if(typeof module!=='undefined'&&module.exports)module.exports=root.VoiceCutNR;
})(typeof window!=='undefined'?window:globalThis);
