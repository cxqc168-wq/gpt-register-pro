const fs = require('fs');
const accounts = JSON.parse(fs.readFileSync('outlook-accounts.json','utf8'));
console.log('=== Outlook 邮箱池 ===');
accounts.accounts.forEach((a,i) => {
  console.log(`${i+1}. ${a.email} | status=${a.status} | boundPhone=${a.boundPhone||'-'} | fetchMode=${a.fetchMode||'-'}`);
});
console.log();
const regs = JSON.parse(fs.readFileSync('accounts.json','utf8'));
console.log('=== 目标账号 ===');
['+639050668187','+639559509484','+639559513120'].forEach(phone => {
  const a = regs.find(r => r.phone === phone);
  if (a) console.log(JSON.stringify(a, null, 2));
});
