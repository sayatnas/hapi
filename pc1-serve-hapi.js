const HAPI_EXE = "K:\\BENCH\\Proto\\hapi-dev\\cli\\dist-exe\\bun-windows-x64\\hapi.exe";
const PORT = 8989;

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    console.log("[GET] " + req.url);
    return new Response(Bun.file(HAPI_EXE), {
      headers: { "Content-Disposition": 'attachment; filename="hapi.exe"' }
    });
  }
});

console.log("Serving hapi.exe on http://100.122.141.75:" + PORT + "/hapi.exe");
console.log("Keep this window open while PC2 downloads. Press Ctrl+C when done.");
