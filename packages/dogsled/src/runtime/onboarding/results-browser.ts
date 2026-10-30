import { icon } from './controls.js';

export const resultsBrowser = String.raw`
function textElement(tag,text){const element=document.createElement(tag);element.textContent=text;return element;}
function appendValue(element,key,value){
 const text=value==null?'Unknown':String(value);
 if(snapshot.display.passageColumns.includes(key)){
  const details=document.createElement('details');details.append(textElement('summary',snapshot.display.passageLabel),textElement('p',text));element.append(details);
 }else element.textContent=text;
}
document.querySelectorAll('[data-results]').forEach(root=>{
 const chapter=snapshot.state.steps.find(x=>x.id===root.dataset.results);
 const tables=root.dataset.results==='all'?snapshot.tables:(chapter?.evidence?.tables||[]);
 let tableIndex=0,page=0,query='',sortKey='',direction=1,opener;
 const tabs=Array.from(root.querySelectorAll('[data-result-tab]'));
 const panels=Array.from(root.querySelectorAll('[data-result-panel]'));
 const search=root.querySelector('[data-search]');
 const searchToggle=root.querySelector('[data-search-toggle]');
 const record=root.nextElementSibling;
 function closeRecord(restoreFocus=false){record.hidden=true;if(restoreFocus&&opener?.isConnected)opener.focus();}
 function inspect(index,button){
  const table=tables[tableIndex],row=table.rows[index];if(!row)return;
  opener=button;
  record.querySelector('[data-record-title]').textContent=String(row.name??row.id??table.name);
  const fields=record.querySelector('[data-record-fields]');fields.replaceChildren();
  table.columns.forEach(key=>{const field=document.createElement('div');const value=document.createElement('dd');appendValue(value,key,row[key]);field.append(textElement('dt',key.replaceAll('_',' ')),value);fields.append(field);});
  record.hidden=false;record.focus({preventScroll:true});record.scrollIntoView({block:'nearest'});
 }
 function draw(){
  const table=tables[tableIndex];if(!table)return;
  const rows=table.rows.map((row,index)=>({row,index})).filter(item=>table.columns.some(key=>String(item.row[key]??'').toLocaleLowerCase().includes(query)));
  if(sortKey)rows.sort((a,b)=>{const x=a.row[sortKey],y=b.row[sortKey];return direction*(typeof x==='number'&&typeof y==='number'?x-y:String(x??'').localeCompare(String(y??'')));});
  page=Math.max(0,Math.min(page,Math.ceil(rows.length/20)-1));
  const panel=panels[tableIndex];const body=panel.querySelector('tbody');body.replaceChildren();
  rows.slice(page*20,page*20+20).forEach(item=>{
   const row=document.createElement('tr');
   table.columns.forEach(key=>{const cell=document.createElement('td');appendValue(cell,key,item.row[key]);if(typeof item.row[key]==='number')cell.className='numeric';row.append(cell);});
   const action=document.createElement('td');action.className='details-column';
   const button=document.createElement('button');button.type='button';button.className='icon-button';button.innerHTML=EXPAND_ICON;
   button.setAttribute('aria-label','Inspect '+String(item.row.name??item.row.id??'row '+(item.index+1)));button.title=button.getAttribute('aria-label');
   button.addEventListener('click',()=>inspect(item.index,button));action.append(button);row.append(action);body.append(row);
  });
  panel.querySelectorAll('[data-sort]').forEach(button=>button.parentElement.setAttribute('aria-sort',button.dataset.sort===sortKey?(direction===1?'ascending':'descending'):'none'));
  const visible=Math.min(rows.length-page*20,20);
  root.querySelector('[data-row-count]').textContent=visible+'/'+table.totalRows;
  root.querySelector('.row-count').setAttribute('aria-label',visible+' visible rows; '+rows.length+' matching saved rows; '+table.totalRows+' total rows');
  root.querySelector('.row-count').title=(rows.length?'Rows '+(page*20+1)+'–'+(page*20+visible):'0 rows')+' of '+rows.length+' matching saved rows';
  root.querySelector('.table-pagination').hidden=rows.length<=20;
  root.querySelector('[data-page=previous]').disabled=page===0;
  root.querySelector('[data-page=next]').disabled=(page+1)*20>=rows.length;
  root.querySelector('.no-matches').hidden=rows.length!==0;
 }
 function selectTable(index){
  if(!tables[index])return;tableIndex=index;page=0;query='';sortKey='';direction=1;search.value='';
  search.parentElement.hidden=true;searchToggle.setAttribute('aria-expanded','false');closeRecord();
  tabs.forEach((tab,i)=>{tab.setAttribute('aria-selected',String(index===i));tab.tabIndex=index===i?0:-1;});
  panels.forEach((panel,i)=>panel.hidden=index!==i);draw();
 }
 tabs.forEach((tab,index)=>{
  tab.addEventListener('click',()=>selectTable(index));
  tab.addEventListener('keydown',event=>{let next;if(event.key==='ArrowRight')next=(index+1)%tabs.length;else if(event.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=tabs.length-1;else return;event.preventDefault();selectTable(next);tabs[next].focus();});
 });
 searchToggle.addEventListener('click',()=>{const open=search.parentElement.hidden;search.parentElement.hidden=!open;searchToggle.setAttribute('aria-expanded',String(open));if(open)search.focus();else{query='';search.value='';page=0;draw();}});
 function closeSearch(){search.parentElement.hidden=true;searchToggle.setAttribute('aria-expanded','false');search.value='';query='';page=0;draw();searchToggle.focus();}
 root.querySelector('[data-search-close]').addEventListener('click',closeSearch);
 search.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();closeSearch();}});
 search.addEventListener('input',()=>{query=search.value.toLocaleLowerCase();page=0;closeRecord();draw();});
 root.querySelectorAll('[data-sort]').forEach(button=>button.addEventListener('click',()=>{direction=sortKey===button.dataset.sort?-direction:1;sortKey=button.dataset.sort;page=0;closeRecord();draw();}));
 root.querySelectorAll('[data-page]').forEach(button=>button.addEventListener('click',()=>{page+=button.dataset.page==='next'?1:-1;closeRecord();draw();}));
 record.querySelector('[data-close-record]').addEventListener('click',()=>closeRecord(true));
 record.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();closeRecord(true);}});
 selectTable(0);
});
`.replace('EXPAND_ICON', JSON.stringify(icon('ExpandAlt')));
