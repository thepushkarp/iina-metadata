(() => {
  // Replace the native IINA bridge while preserving the real sidebar renderer.
  // This bridge has no network or filesystem capabilities.
  const callbacks={};
  const state=structuredClone(window.demoState);
  const candidate={provider:'tmdb',kind:'movie',id:575813,title:'Spring',year:2019,overview:state.metadata.overview,poster:state.metadata.poster.standard};
  const send=(name,value)=>callbacks[name]?.(encodeURIComponent(JSON.stringify(value)));
  const update=()=>send('state',state);
  window.iina={
    onMessage:(name,callback)=>{callbacks[name]=callback;},
    postMessage:(name,data)=>{
      if(name==='ready')update();
      else if(name==='search') setTimeout(()=>{
        const found=data.kind==='movie'&&'spring'.includes(data.title.toLowerCase())&&(!data.year||data.year===2019);
        send('search-results',{candidates:found?[candidate]:[],error:found?undefined:'Sample library: try Spring (2019).'});
      },220);
      else if(name==='choose') {state.confidence='high';state.via='manual match';delete state.results;update();document.querySelector('#main').scrollIntoView();}
      else if(name==='save') {
        state.saving=true;update();
        setTimeout(()=>{state.saving=false;state.results=state.plan.map(item=>({...item,ok:true,message:'Sample only — no files changed.'}));update();},450);
      } else if(name==='identify')update();
      else if(name==='open') document.querySelector('#demo-notice').textContent='Provider links open from the installed plugin.';
      else throw new Error(`Unsupported demo bridge message: ${name}`);
    }
  };
  addEventListener('message',event=>{
    if(event.source===parent&&event.data?.type==='landing-theme')document.documentElement.dataset.theme=event.data.theme;
  });
  document.addEventListener('DOMContentLoaded',()=>{
    // Native candidate rows use clicks. Add keyboard access for the web demo.
    new MutationObserver(()=>document.querySelectorAll('[data-candidate]').forEach(row=>{row.setAttribute('role','button');row.tabIndex=0;})).observe(document.querySelector('#candidates'),{childList:true});
    document.querySelector('#candidates').addEventListener('keydown',event=>{if(event.target.matches('[data-candidate]')&&['Enter',' '].includes(event.key)){event.preventDefault();event.target.click();}});
    parent.postMessage({type:'demo-ready'},'*');
  });
})();
