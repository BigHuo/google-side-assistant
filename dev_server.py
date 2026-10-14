# dev 专用服务：静态文件 + 给 page/sidepanel.html 注入 chrome.* shim。
#
# 侧边栏面板本身依赖 chrome.storage.local（数据层）与 chrome.runtime.sendMessage
# （动作执行），在普通标签页里这两个都不存在，页面会直接卡在启动第一步。
# 这里只做两件事：起静态服务、在 sidepanel.html 的 </body> 前塞一段 shim，
# 把 storage 落到 localStorage 上（刷新后数据还在），sendMessage 一律报错。
#
# 扩展环境不经过此文件；仅本地开发用。
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PAGE = "page/sidepanel.html"

SHIM = """<script>
// dev shim：把面板用到的 chrome.* 补上（仅本地预览，扩展环境不加载）
(function () {
  var c = globalThis.chrome || (globalThis.chrome = {});
  var KEY = "sa-dev-store";
  var load = function () {
    try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { return {}; }
  };
  var save = function (o) { localStorage.setItem(KEY, JSON.stringify(o)); };
  var pick = function (all, keys) {
    var out = {};
    if (keys == null) { for (var k in all) out[k] = all[k]; return out; }
    if (typeof keys === "string") keys = [keys];
    if (Array.isArray(keys)) {
      for (var i = 0; i < keys.length; i++) if (keys[i] in all) out[keys[i]] = all[keys[i]];
      return out;
    }
    for (var k2 in keys) out[k2] = (k2 in all) ? all[k2] : keys[k2];
    return out;
  };
  c.storage = { local: {
    get: async function (keys) { return pick(load(), keys); },
    set: async function (patch) { save(Object.assign(load(), patch)); },
    remove: async function (keys) {
      var all = load();
      (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { delete all[k]; });
      save(all);
    },
    clear: async function () { save({}); },
  } };
  c.runtime = {
    // dev 预览没有 background：把页面动作记到 window.__lastAction（本地调试/测试用），
    // read_page 给一截假正文让带工具的对话流程能走通，其余动作照旧报错。
    sendMessage: async function (msg) {
      globalThis.__lastAction = msg;
      if (msg && msg.type === "PAGE_ACTION" && msg.name === "read_page") {
        return { ok: true, summary: "dev 桩读取完成（非真实页面）", text: "这是 dev 桩返回的页面正文，仅用于本地预览。" };
      }
      throw new Error("dev 预览：没有 background，动作执行不可用");
    },
    lastError: null,
  };
  console.log("[dev] chrome.* shim 已注入；数据存在 localStorage." + KEY);
})();
</script>"""


class DevHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            self.send_response(302)
            self.send_header("Location", "/" + PAGE)
            self.end_headers()
            return
        if path == "/" + PAGE:
            html = (ROOT / PAGE).read_text(encoding="utf-8")
            html = html.replace("</body>", SHIM + "\n</body>")
            data = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        super().do_GET()

    def end_headers(self):
        # dev 里别缓存，改完 CSS/JS 刷新就能看到
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8801
    srv = ThreadingHTTPServer(("127.0.0.1", port), DevHandler)
    print("dev server on http://127.0.0.1:%d  ->  /%s" % (port, PAGE))
    srv.serve_forever()
