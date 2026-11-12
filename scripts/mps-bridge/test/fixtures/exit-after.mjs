// Test child: `exit-after.mjs <ms> <code>` exits with <code> after <ms>.
const ms = Number(process.argv[2]);
const code = Number(process.argv[3]);
console.log("exit-after running");
setTimeout(() => process.exit(code), ms);
