'use strict';
const fs=require('node:fs'), path=require('node:path'), assert=require('node:assert/strict');
const {chromium}=require('C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const CHROME='C:/Users/admin/.cache/hyperframes/chrome/chrome-headless-shell/win64-152.0.7977.30/chrome-headless-shell-win64/chrome-headless-shell.exe';
const root=path.resolve(__dirname,'..'), dir=path.join(root,'qa',process.argv[2] || '真实页面验收_v3_20261017');
fs.mkdirSync(dir,{recursive:false});
(async()=>{
  const context=await chromium.launchPersistentContext(path.join(dir,'browser-profile'),{executablePath:CHROME,headless:true,viewport:{width:1440,height:1050},downloadsPath:dir,env:{...process.env,TEMP:dir,TMP:dir},args:['--disable-crash-reporter','--no-sandbox']});
  try {
    const page=context.pages()[0]||await context.newPage(), errors=[];
    page.on('pageerror',err=>errors.push(err.message)); page.setDefaultTimeout(25000);
    await page.goto('http://127.0.0.1:4174/dist/index.html',{waitUntil:'networkidle'});
    await page.locator('#networkStatus').filter({hasText:'已连接'}).waitFor();
    assert.match(await page.locator('footer').innerText(),/v3\.20261017\.01/);
    await page.locator('#loadReadOnlySample').click(); await page.locator('#demoGas').click(); await page.locator('#checkTransfer').click();
    await page.locator('#preflightResult h3').filter({hasText:'高于普通转账'}).waitFor();
    await page.locator('#adoptGas').click(); await page.locator('#preflightResult h3').filter({hasText:'Gas 配置无需下调'}).waitFor();
    assert.equal(await page.locator('#preflightResult .scope-notice').isVisible(),true);
    await page.locator('#useSampleTx').click(); await page.locator('#txResult h3').filter({hasText:'执行成功'}).waitFor();
    assert.equal(await page.locator('#txHash').inputValue(),'0x259c38e33e254e9eb65e64f49e72f9cd421deb01acf7eb108bbc5f9ad096c46b');
    const result=await page.locator('#txResult').innerText();
    assert.match(result,/已最终确认/); assert.match(result,/RPC finalized/); assert.match(result,/71,755,949/); assert.match(result,/0\.002142 MON/);
    const full=path.join(dir,'BlitzSOS_提交截图_完整页面_v3_20261017.png');
    const cards=path.join(dir,'BlitzSOS_提交截图_费用与真实回执_v3_20261017.png');
    await page.screenshot({path:full,fullPage:true}); await page.locator('.workspace').screenshot({path:cards});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    assert.deepEqual(errors,[]);
    const report={build:'v3.20261017.01',capturedAt:new Date().toISOString(),url:page.url(),realRPC:true,mocks:false,walletConnected:false,newTransactionsSent:0,resultText:result,screenshots:[full,cards],pageErrors:errors,mobileOverflow:false};
    fs.writeFileSync(path.join(dir,'真实浏览器只读验收_v3_20261017.json'),JSON.stringify(report,null,2),{flag:'wx',encoding:'utf8'});
    console.log(JSON.stringify({passed:true,screenshots:report.screenshots,realRPC:true,newTransactionsSent:0},null,2));
  } finally {await context.close();}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
