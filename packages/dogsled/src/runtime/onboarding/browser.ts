/** Browser behaviour explores the embedded snapshot. It never executes project commands. */
export const browserScript = String.raw`
'use strict';
const snapshot=JSON.parse(document.getElementById('snapshot').textContent);
const chapters=Array.from(document.querySelectorAll('[data-step]'));
const workspace=document.getElementById('workspace');
const currentId=snapshot.progress?.current||chapters.find(x=>x.dataset.status!=='complete')?.id||chapters[0]?.id;
let selectedId=currentId;
const previousChapter=document.getElementById('previous-chapter');
const nextChapter=document.getElementById('next-chapter');
const reviewChapter=document.getElementById('review-chapter');
function selectChapter(id,focus=false){
 const chapter=chapters.find(x=>x.id===id);if(!chapter)return;
 selectedId=id;
 chapters.forEach(x=>x.hidden=x!==chapter);
 document.querySelectorAll('[data-chapter-link]').forEach(link=>{if(link.dataset.chapterLink===id)link.setAttribute('aria-current','step');else link.removeAttribute('aria-current');});
 const index=chapters.indexOf(chapter);
 previousChapter.hidden=index===0;nextChapter.hidden=index===chapters.length-1;
 reviewChapter.disabled=chapter.dataset.status!=='complete'||chapter.dataset.reviewed==='true';
 reviewChapter.textContent=chapter.dataset.reviewed==='true'?'Reviewed':'Mark as reviewed';
 if(workspace)chapter.querySelector('[data-workspace-host]').append(workspace);
 sizeActions();
 if(focus){chapter.querySelector('h1').focus({preventScroll:true});window.scrollTo({top:0});}
}
function followHash(){
 const hash=location.hash.slice(1);
 const id=chapters.find(x=>x.id===hash||hash==='results-'+x.id||hash==='ready-'+x.id)?.id;
 if(id)selectChapter(id);
 const target=document.getElementById(hash);
 if(target){let parent=target;while(parent){if(parent.tagName==='DETAILS')parent.open=true;parent=parent.parentElement;}}
}
document.querySelectorAll('[data-chapter-link]').forEach(link=>{
 const chapter=chapters.find(x=>x.id===link.dataset.chapterLink);link.dataset.reviewed=chapter?.dataset.reviewed||'false';
 link.addEventListener('click',()=>selectChapter(link.dataset.chapterLink,true));
});
previousChapter.addEventListener('click',()=>{const index=chapters.findIndex(x=>x.id===selectedId);if(index>0){selectChapter(chapters[index-1].id,true);location.hash=selectedId;}});
nextChapter.addEventListener('click',()=>{const index=chapters.findIndex(x=>x.id===selectedId);if(index<chapters.length-1){selectChapter(chapters[index+1].id,true);location.hash=selectedId;}});
document.querySelectorAll('[data-return-current]').forEach(button=>button.addEventListener('click',()=>{selectChapter(currentId,true);location.hash=currentId;}));
function fallbackCopy(text,source){
 if(source){source.focus();const range=document.createRange();range.selectNodeContents(source);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);}
 else{const area=document.createElement('textarea');area.value=text;area.setAttribute('aria-label','Text to copy');document.getElementById('question').open=true;document.querySelector('.context-body').prepend(area);area.focus();area.select();}
 document.getElementById('copy-status').textContent='Clipboard unavailable. Text selected; copy it manually.';
}
async function copyText(text,button,source){
 try{await navigator.clipboard.writeText(text);document.getElementById('copy-status').textContent='Copied.';if(button){const label=button.getAttribute('aria-label');button.setAttribute('aria-label','Copied');button.setAttribute('title','Copied');setTimeout(()=>{button.setAttribute('aria-label',label||'Copy');button.setAttribute('title',label||'Copy');},2000);}}
 catch{fallbackCopy(text,source);}
}
document.querySelectorAll('[data-copy-target]').forEach(button=>button.addEventListener('click',()=>{const source=document.getElementById(button.dataset.copyTarget);copyText(source.textContent,button,source);}));
reviewChapter.addEventListener('click',()=>{
 const chapter=chapters.find(x=>x.id===selectedId);if(!chapter||reviewChapter.disabled)return;
 const source=document.getElementById('request-'+selectedId);source.textContent=chapter.dataset.reviewRequest;
 chapter.querySelector('.review-hint').hidden=false;
 document.getElementById('ready-'+selectedId).scrollIntoView({block:'start'});
 copyText(source.textContent,chapter.querySelector('[data-copy-target]'),source);
 // Only a regenerated snapshot from the CLI journal can confirm a review.
});
document.addEventListener('click',event=>{const button=event.target.closest('[data-copy]');if(button)copyText(button.dataset.copy,button);});
let selectedFile;
function showFile(path){
 selectedFile=(snapshot.files||[]).find(file=>file.path===path);
 if(!selectedFile){document.getElementById('copy-status').textContent='This file has not been created or is outside the safe preview.';return;}
 document.getElementById('files').open=true;
 document.getElementById('file-name').textContent=selectedFile.path;
 document.getElementById('file-content').textContent=selectedFile.content;
 document.querySelectorAll('[data-tree-file]').forEach(button=>{if(button.dataset.file===path){button.setAttribute('aria-current','true');let parent=button.parentElement;while(parent){if(parent.tagName==='DETAILS')parent.open=true;parent=parent.parentElement;}}else button.removeAttribute('aria-current');});
 document.getElementById('file-content').parentElement.focus();
 document.getElementById('files').scrollIntoView({block:'start'});
}
document.addEventListener('click',event=>{const button=event.target.closest('[data-file]');if(button){event.preventDefault();showFile(button.dataset.file);}});
document.getElementById('copy-file')?.addEventListener('click',event=>{if(selectedFile)copyText(selectedFile.content,event.currentTarget,document.getElementById('file-content'));});
document.querySelector('[data-context]').addEventListener('click',()=>{document.getElementById('question').open=true;document.getElementById('question').scrollIntoView({block:'start'});document.querySelector('.more-menu').open=false;});
document.getElementById('theme').addEventListener('change',event=>{if(event.target.value==='system')delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=event.target.value;});
const moreMenu=document.querySelector('.more-menu');
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&moreMenu.open){event.preventDefault();moreMenu.open=false;moreMenu.querySelector('summary').focus();}});
document.addEventListener('click',event=>{if(moreMenu.open&&!moreMenu.contains(event.target))moreMenu.open=false;});
window.addEventListener('hashchange',followHash);
function sizeActions(){const height=document.querySelector('.checkout-actions').getBoundingClientRect().height;document.documentElement.style.setProperty('--actions-height',height+'px');}
window.addEventListener('resize',sizeActions);
document.documentElement.classList.add('js');selectChapter(selectedId);followHash();sizeActions();
`;
