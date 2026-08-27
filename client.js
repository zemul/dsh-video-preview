/*!
 * dsh-video-preview — client half (browser bundle).
 *
 * Registers a file viewer with dsh-better-sidebar via `ctx.betterSidebar`
 * so video files open in the sidebar editor as an inline <video> player.
 *
 * Bundle format: the official DSH client-bundle shape — a lazy-CJS closure
 * registered with window.__ModuleLoader__.load({ id, factory }). `react` is
 * an external resolved from the shell's module table at runtime; everything
 * else is inlined. The viewer streams from the plugin's own /video host route
 * (HTTP Range → seeking works), falling back to the built-in download route.
 */
window.__ModuleLoader__.load({
  id: "dsh-video-preview",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    "use strict";

    // src/client/index.js
    var import_react = require("react");

    /** File extensions this viewer claims (lowercase, no dot). */
    var VIDEO_EXTS = [
      "mp4", "webm", "mov", "qt", "m4v", "mkv", "avi", "wmv", "flv",
      "ogv", "ogg", "mpeg", "mpg", "3gp", "3g2", "m2ts"
    ];

    /** Absolute URL of the plugin's range-capable video route. */
    function videoUrl(scope, path) {
      var params = new URLSearchParams({ sessionId: scope.sessionId, path: path });
      if (scope.cwd !== undefined && scope.cwd !== "") params.set("cwd", scope.cwd);
      return "/video?" + params.toString();
    }

    /** Absolute URL of the built-in download route (fallback for formats the
     *  browser cannot decode — the <video> onError path still lets the user
     *  grab the raw file). */
    function downloadUrl(scope, path) {
      var params = new URLSearchParams({ sessionId: scope.sessionId, path: path });
      if (scope.cwd !== undefined && scope.cwd !== "") params.set("cwd", scope.cwd);
      params.set("download", "1");
      return "/sidebar/file?" + params.toString();
    }

    /**
     * Settings-inventory glyph in the app's outline style (16px, 1.5px
     * stroke, currentColor): a video screen with a filled play triangle.
     */
    function IconVideoOutline16(size) {
      return import_react.createElement("svg", {
        width: size,
        height: size,
        viewBox: "0 0 16 16",
        fill: "none",
        xmlns: "http://www.w3.org/2000/svg"
      }, [
        import_react.createElement("rect", {
          key: "frame",
          x: 1.5,
          y: 3,
          width: 13,
          height: 10,
          rx: 2,
          stroke: "currentColor",
          strokeWidth: 1.5
        }),
        import_react.createElement("path", {
          key: "play",
          d: "m6 5.75 4.25 2.25L6 10.25z",
          fill: "currentColor",
          stroke: "none"
        })
      ]);
    }

    /** ReactNode: the inline player. Props = FileViewerProps. */
    function VideoView(props) {
      var scope = props.scope;
      var path = props.path;
      var url = videoUrl(scope, path);
      var dl = downloadUrl(scope, path);
      return import_react.createElement("div", {
        style: {
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          padding: "12px",
          minWidth: 0,
          minHeight: 0,
          height: "100%",
          boxSizing: "border-box"
        }
      }, [
        import_react.createElement("video", {
          key: "v",
          src: url,
          controls: true,
          preload: "metadata",
          playsInline: true,
          style: {
            width: "100%",
            maxHeight: "100%",
            flex: "1 1 auto",
            minHeight: 0,
            background: "#000",
            borderRadius: "6px",
            outline: "none"
          }
        }),
        import_react.createElement("div", {
          key: "meta",
          style: {
            display: "flex",
            alignItems: "center",
            gap: "10px",
            flex: "none",
            fontSize: "12px",
            color: "var(--dsw-alias-label-secondary, #8b90a0)",
            minWidth: 0
          }
        }, [
          import_react.createElement("span", {
            key: "t",
            title: path,
            style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "1 1 auto" }
          }, props.title),
          import_react.createElement("a", {
            key: "d",
            href: dl,
            download: true,
            style: {
              flex: "none",
              color: "var(--dsw-alias-link-normal, #4c8dff)",
              textDecoration: "none"
            }
          }, "\u4E0B\u8F7D")
        ])
      ]);
    }

    /** Cordis service dependencies (the better-sidebar registry service). */
    var inject = ["betterSidebar"];

    function apply(ctx) {
      // Registration must be wrapped in ctx.effect so the disposer returned by
      // registerFileViewer is invoked on fiber teardown (HMR / plugin disable);
      // otherwise a later re-activation throws "already registered".
      ctx.effect(function () {
        return ctx.betterSidebar.registerFileViewer({
          id: "video",
          title: "Video",
          icon: function (size) { return IconVideoOutline16(size); },
          exts: VIDEO_EXTS,
          fetchStrategy: "none",
          component: VideoView
        });
      });
    }

    module.exports = { inject: inject, apply: apply };
    return module.exports;
  }
});
