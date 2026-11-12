// Local-only UI checks in an isolated headless Brave profile. No user browser is touched.
// Run from the project directory: node .preview-qa/mobile-check.cjs
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const baseURL = process.env.PREVIEW_URL || 'http://localhost:8080/';
const executable = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const output = path.join(__dirname, 'screenshots');
fs.mkdirSync(output, {recursive:true});
const report = {url:baseURL, viewports:[], errors:[], screenshots:[]};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, socket, profile, sequence = 0;
const pending = new Map();
const runtimeErrors = [];

function request(method, params = {}, sessionId){
  return new Promise((resolve,reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {pending.delete(id); reject(new Error(`${method} timed out`));},15000);
    pending.set(id,{resolve,reject,timer});
    socket.send(JSON.stringify({id,method,params,...(sessionId ? {sessionId} : {})}));
  });
}

async function launch(){
  profile = fs.mkdtempSync(path.join(os.tmpdir(),'farrah-mobile-qa-'));
  report.temporaryProfile = profile;
  const endpoint = await new Promise((resolve,reject) => {
    browser = spawn(executable,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
    const timeout = setTimeout(() => reject(new Error('Headless browser did not expose a DevTools endpoint')),15000);
    let stderr = '';
    browser.once('error',error => {clearTimeout(timeout); reject(error);});
    browser.stderr.on('data',data => {
      stderr += data;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if(match){clearTimeout(timeout); resolve(match[1]);}
    });
    browser.once('exit',code => {clearTimeout(timeout); reject(new Error(`Browser exited during startup (${code}): ${stderr.slice(-800)}`));});
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve,reject) => {socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  socket.addEventListener('message',event => {
    const message = JSON.parse(event.data);
    if(message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails.text + ': ' + (message.params.exceptionDetails.exception?.description || ''));
    if(!message.id) return;
    const waiter = pending.get(message.id);
    if(!waiter) return;
    clearTimeout(waiter.timer); pending.delete(message.id);
    if(message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });
}

async function createPage(width,height,reduced = true){
  const {targetId} = await request('Target.createTarget',{url:'about:blank'});
  const {sessionId} = await request('Target.attachToTarget',{targetId,flatten:true});
  const send = (method,params) => request(method,params,sessionId);
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async (expression, label, timeout = 6000) => {
    const deadline = Date.now() + timeout;
    while(Date.now()<deadline){if(await evaluate(expression)) return;await delay(50);}
    throw new Error(`Timed out: ${label}`);
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<600,screenWidth:width,screenHeight:height});
  await send('Emulation.setTouchEmulationEnabled',{enabled:width<600,maxTouchPoints:5});
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:reduced ? 'reduce' : 'no-preference'}]});
  await send('Page.navigate',{url:baseURL});
  await waitFor("document.readyState === 'complete' && document.documentElement.classList.contains('paged')",'page initialization',12000);
  await evaluate("Promise.race([document.fonts.ready, new Promise(r => setTimeout(r,5000))]).then(() => true)");

  async function tap(selector){
    const point = await evaluate(`(() => {
      const el=document.querySelector(${JSON.stringify(selector)});
      if(!el) throw new Error('Missing tap target: '+${JSON.stringify(selector)});
      const section=el.closest('main > section');
      if(section){const r=el.getBoundingClientRect(),s=section.getBoundingClientRect();section.scrollTop += r.top-s.top+r.height/2-section.clientHeight/2;}
      const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,width:r.width,height:r.height};
    })()`);
    if(point.x<0 || point.x>width || point.y<0 || point.y>height) throw new Error(`Tap target outside viewport: ${selector} ${JSON.stringify(point)}`);
    if(width<600){
      await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y}]});
      await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    }else{
      await send('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1});
      await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1});
    }
  }
  async function screenshot(name){
    const {data} = await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    const filename = path.join(output,`${width}x${height}-${name}.png`);
    fs.writeFileSync(filename,Buffer.from(data,'base64'));
    report.screenshots.push(filename);
  }
  const visible = "Array.from(document.querySelectorAll('main > section')).filter(s => !s.hidden)";
  const activeCheck = index => `(() => {const all=${visible}, p=document.getElementById('top'), s=all[${index}];return s && !s.inert && all.every((other,i) => i===${index} || other.inert) && Math.abs(p.scrollTop-s.offsetTop)<2;})()`;
  const open = async () => {await tap('#open');await waitFor("document.documentElement.classList.contains('opened') && " + activeCheck(0),'envelope opens');};
  const homeCheck = `!document.documentElement.classList.contains('opened') && !document.getElementById('intro').inert && !document.getElementById('env').classList.contains('opening') && (${visible}).every(s => s.inert) && document.getElementById('top').scrollTop===0`;
  return {targetId,send,evaluate,waitFor,tap,screenshot,visible,activeCheck,open,homeCheck};
}

async function checkViewport(width,height){
  const entry={width,height,sections:[],issues:[],tapTargetWarnings:[]};
  report.viewports.push(entry);
  const p=await createPage(width,height);
  try{
    const intro=await p.evaluate("(() => {const r=document.getElementById('open').getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom};})()");
    if(intro.left<0 || intro.top<0 || intro.right>width+1 || intro.bottom>height+1) entry.issues.push(`Envelope control clipped: ${JSON.stringify(intro)}`);
    await p.screenshot('envelope');
    await p.open();
    const sections=await p.evaluate(`(${p.visible}).map(s=>({id:s.id,name:s.className || 'countdown'}))`);
    for(let i=0;i<sections.length;i++){
      const section=sections[i], selector='#'+section.id;
      await p.waitFor(p.activeCheck(i),`section ${i+1} aligned and interactive`);
      const metrics=await p.evaluate(`(() => {const s=document.querySelector(${JSON.stringify(selector)}),p=document.getElementById('top');return {name:s.querySelector('h1,h2').textContent,clientWidth:s.clientWidth,scrollWidth:s.scrollWidth,clientHeight:s.clientHeight,scrollHeight:s.scrollHeight,documentWidth:document.documentElement.scrollWidth,pageWidth:p.scrollWidth,buttons:[...s.querySelectorAll('button,a[href]')].map(b=>{const r=b.getBoundingClientRect();return {name:b.getAttribute('aria-label')||b.textContent.trim(),width:r.width,height:r.height,tag:b.tagName};})};})()`);
      entry.sections.push(metrics);
      if(metrics.scrollWidth>metrics.clientWidth+2 || metrics.documentWidth>width+2 || metrics.pageWidth>width+2) entry.issues.push(`Horizontal overflow in ${metrics.name}: ${metrics.scrollWidth}/${metrics.clientWidth}, document ${metrics.documentWidth}`);
      for(const button of metrics.buttons){if(button.width<43.5 || button.height<43.5) entry.tapTargetWarnings.push({section:metrics.name,...button});}
      // Large scroll/swipe must remain within the current section.
      const center=await p.evaluate(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width*.8,y:r.top+r.height*.7};})()`);
      if(width<600){
        await p.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[center]});
        for(let step=1;step<=6;step++){await p.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:center.x,y:center.y-height*.08*step}]});await delay(20);}
        await p.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      }else await p.send('Input.dispatchMouseEvent',{type:'mouseWheel',...center,deltaX:0,deltaY:1600});
      await delay(200);
      if(!await p.evaluate(p.activeCheck(i))) entry.issues.push(`Swipe/wheel escaped section ${metrics.name}`);
      await p.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollTop=0`);
      if(width===390 || (width===320 && /hero|msg|blessing/.test(section.name)) || i===0){
        const label=section.name.replace(/[^a-z0-9]+/gi,'-');
        await p.screenshot(`${i+1}-${label}-top`);
        if(metrics.scrollHeight>metrics.clientHeight+2){
          await p.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollTop=1e6`);
          await p.screenshot(`${i+1}-${label}-bottom`);
          await p.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollTop=0`);
        }
      }
      if(section.name.includes('gallery')){
        await p.tap(selector+' .pola');
        await p.waitFor("document.getElementById('lb').open && document.querySelector('#lb img').naturalWidth>0",'gallery photo dialog');
        const close=await p.evaluate("(() => {const r=document.querySelector('#lb button').getBoundingClientRect();return {width:r.width,height:r.height,left:r.left,top:r.top,right:r.right,bottom:r.bottom};})()");
        if(close.width<43.5 || close.height<43.5) entry.tapTargetWarnings.push({section:'photo dialog',name:'Close',...close});
        if(close.left<0 || close.top<0 || close.right>width+1 || close.bottom>height+1) entry.issues.push('Gallery close button is clipped');
        if(width===390) await p.screenshot('gallery-dialog');
        await p.tap('#lb button');
        await p.waitFor("!document.getElementById('lb').open",'gallery closes');
      }
      await p.tap(selector+' .next-page');
      if(i===sections.length-1) await p.waitFor(p.homeCheck,'last page returns to envelope');
    }
    // Re-open, visit another page, then use its Home control.
    await p.open();
    await p.tap('#'+sections[0].id+' .next-page');
    await p.waitFor(p.activeCheck(1),'reopened next page');
    await p.tap('#'+sections[1].id+' .home-page');
    await p.waitFor(p.homeCheck,'Home returns to closed envelope');
    await p.open();
    entry.reopenPassed=await p.evaluate(p.activeCheck(0));
    entry.passed=entry.issues.length===0;
    console.log(`${width}x${height}: ${entry.passed ? 'PASS' : 'FAIL'}, ${sections.length} pages, ${entry.tapTargetWarnings.length} tap-target warnings`);
  }catch(error){entry.issues.push(error.message);entry.passed=false;console.log(`${width}x${height}: FAIL ${error.message}`);try{await p.screenshot('failure');}catch{}}
  finally{await request('Target.closeTarget',{targetId:p.targetId});}
}

async function checkDefaultMotion(){
  const p=await createPage(390,844,false);
  try{
    await p.open();
    await p.tap('main > section:not([hidden]) .next-page');
    // Exercise cancellation of a pending smooth-scroll completion callback.
    await p.evaluate("document.querySelector('.hero .home-page').click()");
    await p.waitFor(p.homeCheck,'Home cancels motion');
    await delay(1500);
    if(!await p.evaluate(p.homeCheck)) throw new Error('A stale page transition changed state after Home');
    await p.open();
    await p.tap('main > section:not([hidden]) .next-page');
    await p.waitFor(p.activeCheck(1),'normal smooth navigation completes');
    await p.tap('main > section:not([inert]) .home-page');
    await p.waitFor(p.homeCheck,'normal-motion Home works');
    report.defaultMotionPassed=true;
    console.log('Default motion Home/reset: PASS');
  }finally{await request('Target.closeTarget',{targetId:p.targetId});}
}

(async () => {
  try{
    await launch();
    for(const [width,height] of [[320,568],[390,844],[430,932],[1280,900]]) await checkViewport(width,height);
    await checkDefaultMotion();
    report.runtimeErrors=runtimeErrors;
  }catch(error){report.errors.push(error.stack || error.message);console.error(error.message);}
  finally{
    fs.writeFileSync(path.join(__dirname,'results.json'),JSON.stringify(report,null,2));
    if(socket?.readyState===WebSocket.OPEN){try{await request('Browser.close');}catch{}socket.close();}
    if(browser && browser.exitCode===null) browser.kill();
    // Keep the isolated temporary profile for diagnostics; never touch the user's profile.
    for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error('Browser closed'));}
    pending.clear();
  }
  process.exitCode=report.errors.length || runtimeErrors.length || report.viewports.some(v=>!v.passed) || !report.defaultMotionPassed ? 1 : 0;
  console.log('Report:',path.join(__dirname,'results.json'));
})().catch(error=>{console.error(error);process.exitCode=1;});
