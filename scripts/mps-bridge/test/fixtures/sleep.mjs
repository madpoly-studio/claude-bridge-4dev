// Test child: stays alive (and ignores SIGINT) until killed.
process.on("SIGINT", () => console.log("got SIGINT"));
console.log("sleeping");
setInterval(() => {}, 1_000);
