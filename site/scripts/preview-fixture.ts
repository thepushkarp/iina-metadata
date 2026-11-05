import { resolve } from 'node:path';

// Load the real plugin webview, replacing only IINA's message bridge with
// fictional state. No plugin host, provider token, or file writes are involved.
const app = resolve(import.meta.dir, '../../ui/sidebar');
const bundle = await Bun.build({entrypoints:[resolve(app,'sidebar.ts')],target:'browser'});
if (!bundle.success) throw new Error(`Could not build sidebar: ${bundle.logs.join('\n')}`);
const script = await bundle.outputs[0].text();
const state = {
  phase:'matched',fileName:'Spring.2019.1080p.mkv',confidence:'high',via:'search',candidates:[],hasToken:true,saving:false,
  metadata:{kind:'movie',provider:'tmdb',title:'Spring',year:2019,genres:['Animation','Fantasy'],
    directors:['Andy Goralczyk'],writers:['Andy Goralczyk'],cast:[],studios:['Blender Studio'],ids:{tmdb:575813},
    overview:'A shepherd girl and her dog encounter ancient forest spirits. An open film by Andy Goralczyk and Blender Studio.',
    poster:{standard:'/spring.jpg',original:'/spring.jpg'}},
  plan:[{label:'Embed in file',target:'Spring.2019.1080p.mkv',action:'write',detail:'title, overview, release date, genres, cast & crew, database ids, cover (mkvpropedit, in place)'},
    {label:'Movie NFO',target:'Spring.2019.1080p.nfo',action:'write'},
    {label:'Poster',target:'Spring.2019.1080p.jpg',action:'write'}],
};
Bun.serve({hostname:'127.0.0.1',port:4333,async fetch(request) {
  const url = new URL(request.url);
  if (request.method !== 'GET') return new Response('Capture fixture is read-only',{status:405});
  if (url.pathname === '/') {
    const html = await Bun.file(resolve(app,'index.html')).text();
    const bridge = `<script>const callbacks={};window.iina={onMessage:(name,callback)=>callbacks[name]=callback,postMessage:name=>{if(name==='ready')callbacks.state(encodeURIComponent(JSON.stringify(${JSON.stringify(state)})))}};</script>`;
    return new Response(html.replace('<head>',`<head>${bridge}<style>body{background:#f5f5f5}@media(prefers-color-scheme:dark){body{background:#242426}}</style>`).replace(/https:\/\/www.themoviedb.org\/assets\/[^\"]+\.svg/,'/tmdb.svg'),{headers:{'Content-Type':'text/html'}});
  }
  if (url.pathname === '/sidebar.js') return new Response(script,{headers:{'Content-Type':'text/javascript'}});
  if (url.pathname === '/sidebar.css') return new Response(Bun.file(resolve(app,'sidebar.css')));
  if (url.pathname === '/tmdb.svg') return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="56" height="15"><text x="0" y="12" fill="#087f9a" font-family="sans-serif" font-weight="bold" font-size="14">TMDB</text></svg>',{headers:{'Content-Type':'image/svg+xml'}});
  if (url.pathname === '/spring.jpg') return new Response(Bun.file(resolve(import.meta.dir,'../public/artwork/spring.jpg')));
  return new Response('Unknown capture route',{status:404});
}});
console.log('IINA sidebar capture fixture: http://127.0.0.1:4333/ ');
