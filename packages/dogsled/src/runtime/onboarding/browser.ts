export const browserScript = String.raw`
const snapshot = JSON.parse(document.getElementById('snapshot').textContent);
const table = document.getElementById('data-body');
const headings = document.getElementById('data-head');
const source = document.getElementById('table-choice');
const search = document.getElementById('search');
const sort = document.getElementById('sort');
let page = 0;
function cell(tag, value) { const el = document.createElement(tag); el.textContent = value == null ? 'Unknown' : String(value); return el; }
function valueCell(tag, key, value) {
 const el = cell(tag, value);
 if (key === 'article_text' || key === 'support_excerpt') {
  const details = document.createElement('details');
  details.append(cell('summary', 'Show passage (may contain spoilers)'), cell('p', value));
  el.replaceChildren(details);
 }
 return el;
}
function draw(resetColumns) {
 const dataset = snapshot.tables[Number(source.value) || 0]; if (!dataset) return;
 if (resetColumns) { sort.replaceChildren(); dataset.columns.forEach(k => { const o = cell('option', k); o.value = k; sort.append(o); }); }
 const term = search.value.toLocaleLowerCase();
 const rows = dataset.rows.filter(r => dataset.columns.some(k => String(r[k] ?? '').toLocaleLowerCase().includes(term))).sort((a,b) => { const x=a[sort.value],y=b[sort.value]; return typeof x==='number' && typeof y==='number' ? x-y : String(x??'').localeCompare(String(y??'')); });
 page = Math.max(0, Math.min(page, Math.ceil(rows.length / 20)-1));
 headings.replaceChildren(); const tr=document.createElement('tr'); dataset.columns.forEach(k=>tr.append(cell('th',k))); tr.append(cell('th','Details'));headings.append(tr);
 table.replaceChildren(); rows.slice(page*20,page*20+20).forEach(r=>{const row=document.createElement('tr');dataset.columns.forEach(k=>{const td=valueCell('td',k,r[k]);if(typeof r[k]==='number')td.className='numeric';row.append(td);});const action=document.createElement('td');const button=cell('button','Inspect');button.type='button';button.addEventListener('click',()=>{const details=document.getElementById('record-detail');details.replaceChildren(cell('h3',dataset.name));const dl=document.createElement('dl');dataset.columns.forEach(k=>{dl.append(cell('dt',k),valueCell('dd',k,r[k]));});details.append(dl);details.hidden=false;details.focus();});action.append(button);row.append(action);table.append(row);});
 document.getElementById('row-count').textContent = rows.length+' matching preview rows · '+dataset.totalRows+' total · page '+(page+1)+' of '+Math.max(1,Math.ceil(rows.length/20));
 document.getElementById('previous').disabled = page===0;
 document.getElementById('next').disabled = (page+1)*20>=rows.length;
}
source.addEventListener('change',()=>{page=0;draw(true);});search.addEventListener('input',()=>{page=0;draw(false);});sort.addEventListener('change',()=>draw(false));
document.getElementById('previous').addEventListener('click',()=>{page--;draw(false);});document.getElementById('next').addEventListener('click',()=>{page++;draw(false);});
document.getElementById('theme').addEventListener('change',e=>{ if(e.target.value==='system')document.documentElement.removeAttribute('data-theme');else document.documentElement.dataset.theme=e.target.value; });
draw(true);
`;
