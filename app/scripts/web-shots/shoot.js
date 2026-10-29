const { chromium } = require('playwright');
const OUT=process.argv[2]; const only=process.argv[3];
(async()=>{
  const b=await chromium.launch();
  const ctx=await b.newContext({viewport:{width:Number(process.env.VW||390),height:Number(process.env.VH||844)},deviceScaleFactor:2,locale:'zh-CN'});
  const p=await ctx.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(String(e))); p.on('console',m=>{if(m.type()==='error')errs.push(m.text())});
  const shot=async(name)=>{await p.waitForTimeout(1200); await p.screenshot({path:`${OUT}/${name}.png`}); console.log('shot',name);};
  const go=async(url)=>{await p.goto('http://localhost:8090'+url,{waitUntil:'networkidle'});};
  const pages=[['today','/?demo=1'],['today-empty','/?demo=empty'],['wardrobe','/wardrobe?demo=1'],['fitting','/fitting?demo=1'],['fitting-noavatar','/fitting?demo=noavatar'],['outfits','/outfits?demo=1'],['me','/me?demo=1'],['review','/review?demo=1'],['capture','/capture?demo=1'],['mirror','/mirror?demo=1'],['avatar','/avatar?demo=noavatar'],['photo','/photo?demo=1'],['apikey','/apikey?demo=1']];
  for(const [n,u] of pages){ if(only&&!n.startsWith(only))continue; await go(u); await shot(n);}
  if(!only||only==='flow'){
    // wardrobe -> select item -> detail
    await go('/wardrobe?demo=1'); await p.getByLabel('军绿牛仔夹克').first().click(); await p.waitForTimeout(300); await p.getByLabel('军绿牛仔夹克').first().click(); await shot('detail');
    // fitting: put on outfit from outfits sheet
    await go('/outfits?demo=1'); await p.getByLabel('周末出门').first().click(); await shot('outfit-sheet');
    await p.getByText('在试衣间打开').click(); await shot('fitting-worn');
    await p.getByLabel('向右转').click(); await shot('fitting-back');
    await go('/outfits?demo=1'); await p.getByText('日历').click(); await shot('calendar');
    await go('/fitting?demo=1'); await p.getByLabel('上衣').click(); await p.getByLabel('牛津衬衫').click(); await p.getByLabel('下装').click(); await p.getByLabel('卡其休闲裤').click(); await p.getByLabel('鞋').click(); await p.getByLabel('乐福鞋').click(); await shot('fitting-collage');
    await p.getByText('保存穿搭').click(); await shot('save-sheet');
  }
  console.log('ERRORS', JSON.stringify(errs.slice(0,10)));
  await b.close();
})();
