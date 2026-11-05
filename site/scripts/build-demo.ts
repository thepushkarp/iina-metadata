import { resolve } from 'node:path';
const app=resolve(import.meta.dir,'../../ui/sidebar');
const poster='data:image/jpeg;base64,'+Buffer.from(await Bun.file(resolve(import.meta.dir,'../public/artwork/spring.jpg')).arrayBuffer()).toString('base64');
const state={
 phase:'matched',fileName:'Spring.2019.1080p.mkv',confidence:'high',via:'search',candidates:[],hasToken:true,saving:false,
 query:{title:'Spring',year:2019,kind:'movie',episodes:[]},
 metadata:{kind:'movie',provider:'tmdb',title:'Spring',year:2019,genres:['Animation','Fantasy'],directors:['Andy Goralczyk'],writers:['Andy Goralczyk'],cast:[],studios:['Blender Studio'],ids:{tmdb:575813},overview:'A shepherd girl and her dog encounter ancient forest spirits. An open film by Andy Goralczyk and Blender Studio.',poster:{standard:poster,original:poster}},
 plan:[{label:'Embed in file',target:'Spring.2019.1080p.mkv',action:'write',detail:'title, overview, release date, genres, cast & crew, database ids, cover (mkvpropedit, in place)'},{label:'Movie NFO',target:'Spring.2019.1080p.nfo',action:'write'},{label:'Poster',target:'Spring.2019.1080p.jpg',action:'write'}],
};
const bundle=await Bun.build({entrypoints:[resolve(app,'sidebar.ts')],target:'browser',format:'iife'});
if(!bundle.success) throw new Error(`Sidebar build failed: ${bundle.logs.join('\n')}`);
const script=await bundle.outputs[0].text();
let css=await Bun.file(resolve(app,'sidebar.css')).text();
css=css.replace(/@media \(prefers-color-scheme: dark\) \{\s*:root \{([^}]+)\}\s*\}/,':root[data-theme="dark"] {$1}');
const runtime=await Bun.file(resolve(import.meta.dir,'../demo/runtime.js')).text();
const csp=`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">`;
let html=(await Bun.file(resolve(app,'index.html')).text()).replace('<main id="main"','<main aria-label="IINA Metadata demo" id="main"').replace('<footer class="small muted">','<footer class="small muted" aria-label="Metadata provider credits">');
html=html.replace('<head>',`<head>${csp}<script>window.demoState=${JSON.stringify(state)};</script><script>${runtime}</script>`)
 .replace('<link rel="stylesheet" href="sidebar.css" />',`<style>${css}\n:root{color-scheme:light} :root[data-theme=dark]{color-scheme:dark}body{background:light-dark(#f5f5f5,#242426)}#token,[hidden]{display:none!important}button,[data-candidate]{cursor:pointer;min-height:30px} :focus-visible{outline:2px solid var(--accent);outline-offset:3px}</style>`)
 .replace('<script src="sidebar.js"></script>',`<p id="demo-notice" class="small muted" role="status"></p><script>${script}</script>`)
 .replace(/<img\s+src="https:\/\/www.themoviedb.org[\s\S]*?\/>/,'<strong>TMDB</strong>');
// Native webview colors need stronger contrast on the fixed browser backdrop.
html=html.replace('</head>','<style>:root:not([data-theme=dark]){--ok:#176d31}:root[data-theme=dark] button.primary{color:#10213a}a{text-decoration:underline;text-underline-offset:2px}@media(pointer:coarse){button,[data-candidate]{min-height:44px}input,select{font-size:16px;min-height:44px}}</style></head>');
await Bun.write(resolve(import.meta.dir,'../public/demo/index.html'),html);
console.log('Built self-contained IINA demo from the real plugin sidebar.');
