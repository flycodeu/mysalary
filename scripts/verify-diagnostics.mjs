// Synthetic data only. This check never reads the user's archive.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.SALARY_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:'msedge',headless:true});
const context=await browser.newContext({viewport:{width:390,height:900}});
const page=await context.newPage();
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
function capture(net,unknown=false){return{format:'salary-capture',version:1,source:{kind:'feishu-text',page:'https://hr.hmifo.com/test/#/wages',capturedAt:'2030-01-01T00:00:00Z'},records:[{payrollMonth:'2030-01',fields:[{label:'应发工资',amountText:'1000'},{label:'实发工资',amountText:String(net)},{label:'基本工资',amountText:'1000'},{label:'个人所得税',amountText:'100'},...(unknown?[{label:'待明确项目',amountText:'10'}]:[])]}]};}
async function upload(value){await page.getByLabel('选择工资文件').setInputFiles({name:'synthetic.salary.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(value))});await page.locator('.working').waitFor({state:'hidden'});await page.locator('.reconciliation > summary').click();}
const checks=[];
try{
 await page.goto(process.env.SALARY_VIEWER_URL||'http://127.0.0.1:5198');
 await page.locator('main[data-storage-state="ready"]').waitFor();
 await upload(capture(890));
 let text=await page.locator('.reconciliation-body').innerText();
 assert.match(text,/总额推导的扣款比已识别扣款多 10.00 元/);
 assert.match(text,/无法仅凭此档案确定/);
 assert.match(text,/原载实发保持不变/);
 assert.equal(await page.locator('.source-totals').innerText().then(text=>text.includes('扣款（推算）')),true);
 checks.push('derived_deductions_are_distinct_from_source_totals_and_listed_deductions');
 const out=fileURLToPath(new URL('../.artifacts/diagnostic-ui/',import.meta.url));
 await mkdir(out,{recursive:true});
 for(const width of [320,390,1280]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:`${out}/expanded-${width}.png`,fullPage:true});}
 checks.push('expanded_panel_has_no_overflow_320_390_1280');
 await page.getByRole('button',{name:'隐藏金额',exact:true}).click();
 text=await page.locator('.reconciliation-body').innerText();
 assert.doesNotMatch(text,/1,000\.00|890\.00|110\.00|100\.00|10\.00/);
 assert.match(text,/••••/);
 await page.getByRole('button',{name:'显示金额',exact:true}).click();
 checks.push('masked_diagnostics_do_not_leak_amounts');
 await upload(capture(910));
 assert.match(await page.locator('.reconciliation-body').innerText(),/已识别扣款比总额推导的扣款多 10.00 元/);
 checks.push('opposite_gap_direction_is_explained');
 await upload(capture(890,true));
 assert.match(await page.locator('.reconciliation > summary').innerText(),/10.00/);
 text=await page.locator('.reconciliation-body').innerText();
 assert.match(text,/已识别扣款（部分）/);
 assert.match(text,/当前扣款小计不完整/);
 assert.match(text,/待明确项目/);
 checks.push('unknown_item_does_not_hide_or_silently_close_partial_gap');
 await page.evaluate(async (source)=>{
   const {draftFromCapture}=await import('/src/domain/capture.ts');
   const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('salary-preview',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
   await new Promise((resolve,reject)=>{
     const tx=db.transaction('imports','readwrite');
     for(const [index,missing] of ['net','gross','both'].entries()){
       const draft=draftFromCapture(source.records[0]);
       draft.payrollMonth=`2029-0${index+1}`;
       if(missing==='net'||missing==='both')draft.statedNetMinor=null;
       if(missing==='gross'||missing==='both')draft.statedGrossMinor=null;
       tx.objectStore('imports').put({id:`legacy-missing-${missing}`,sha256:`synthetic-missing-${missing}`,fileName:'synthetic-legacy.json',imagePath:'',width:0,height:0,createdAt:'2030-01-01T00:00:00Z',status:'recognized',draft});
     }
     tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
   });
   db.close();
 },capture(900));
 await page.setViewportSize({width:390,height:900});
 await page.reload();
 await page.locator('main[data-storage-state="ready"]').waitFor();
 for(const month of [1,2,3]){
   await page.locator('.year-section').filter({has:page.getByRole('heading',{name:'2029 年',exact:true})}).locator('.archive-item').filter({has:page.locator('.month-number',{hasText:new RegExp(`^${month}\\s*月$`)})}).click();
   assert.match(await page.locator('.reconciliation > summary').innerText(),/原载总额缺失，无法完整核对/);
   await page.locator('.reconciliation > summary').click();
   text=await page.locator('.reconciliation-body').innerText();
   assert.match(text,/原载应发或实发缺失，无法推导扣款及比较差额/);
   assert.doesNotMatch(text,/已识别扣款（部分）|当前扣款小计不完整|未归类/);
   assert.equal(await page.locator('.reconciliation-body dl > div').filter({has:page.locator('dt',{hasText:/^已识别扣款$/})}).locator('dd').innerText(),'100.00');
   await page.getByRole('button',{name:'工资档案',exact:true}).click();
 }
 checks.push('legacy_missing_source_totals_do_not_mislabel_complete_deduction_details');
 assert.deepEqual(errors,[]);
 await writeFile(`${out}/checks.json`,JSON.stringify({status:'PASS',source:'synthetic',checks},null,2));
 console.log(JSON.stringify({status:'PASS',checks}));
}finally{await context.close();await browser.close();}
