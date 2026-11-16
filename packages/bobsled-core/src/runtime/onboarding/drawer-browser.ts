/** Offcanvas chapter navigation is presentation only; it does not change journal progress. */
export const drawerBrowser = String.raw`
'use strict';
const chapterMenu=document.getElementById('chapter-menu');
const chapterToggle=document.getElementById('chapters-toggle');
const chapterClose=document.querySelector('[data-chapters-close]');
const chapterBackdrop=document.querySelector('[data-chapters-backdrop]');
const chapterMain=document.querySelector('main');
const chapterMedia=window.matchMedia('(max-width: 699px)');
let chaptersOpen=false;
function closeChapters(restoreFocus=true){
 const wasOpen=chaptersOpen;
 chaptersOpen=false;
 document.documentElement.classList.remove('chapters-open');
 chapterToggle.setAttribute('aria-expanded','false');
 chapterBackdrop.hidden=true;
 chapterMain.inert=false;
 chapterMenu.removeAttribute('role');chapterMenu.removeAttribute('aria-modal');
 chapterMenu.inert=chapterMedia.matches;
 if(chapterMedia.matches)chapterMenu.setAttribute('aria-hidden','true');else chapterMenu.removeAttribute('aria-hidden');
 if(wasOpen&&restoreFocus)chapterToggle.focus();
}
function openChapters(){
 if(!chapterMedia.matches)return;
 chaptersOpen=true;
 document.querySelector('.more-menu').open=false;
 document.documentElement.classList.add('chapters-open');
 chapterToggle.setAttribute('aria-expanded','true');
 chapterBackdrop.hidden=false;
 chapterMenu.inert=false;chapterMenu.removeAttribute('aria-hidden');
 chapterMenu.setAttribute('role','dialog');chapterMenu.setAttribute('aria-modal','true');
 chapterMain.inert=true;
 (chapterMenu.querySelector('[aria-current="step"]')||chapterClose).focus();
}
chapterToggle.addEventListener('click',()=>chaptersOpen?closeChapters():openChapters());
chapterClose.addEventListener('click',()=>closeChapters());
chapterBackdrop.addEventListener('click',()=>closeChapters());
chapterMenu.addEventListener('keydown',event=>{
 if(!chaptersOpen)return;
 if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeChapters();}
 if(event.key==='Tab'){
  const items=Array.from(chapterMenu.querySelectorAll('a[href],button:not(:disabled)'));
  const first=items[0],last=items[items.length-1];
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
 }
});
chapterMedia.addEventListener('change',()=>{
 const focusWasInMenu=chapterMenu.contains(document.activeElement);
 closeChapters(false);
 if(chapterMedia.matches&&focusWasInMenu)chapterToggle.focus();
 else if(!chapterMedia.matches&&document.activeElement===chapterClose)chapterMenu.querySelector('[aria-current="step"]')?.focus();
});
closeChapters(false);
`;
