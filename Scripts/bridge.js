/* =====================================================================
 * bridge.js — console + error relay from the page to the WPF host.
 *
 * Injected via CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(),
 * so it runs BEFORE any page script on every document (including SPA
 * reloads and iframes) and survives navigation without host involvement.
 *
 * Message contract (must match BridgeMessage in MainWindow.xaml.cs):
 *   { type:'console', level:'log'|'warn'|'error'|'info'|'debug',
 *     text:string, source:string }
 *   { type:'error',   text:string, source:string }
 * ===================================================================== */
(function () {
    'use strict';

    if (window.__wpfBridgeInstalled) return;
    window.__wpfBridgeInstalled = true;

    var canPost = !!(window.chrome && window.chrome.webview &&
                     typeof window.chrome.webview.postMessage === 'function');

    /** Safe post — never let the bridge throw into page code. */
    function post(payload) {
        if (!canPost) return;
        try { window.chrome.webview.postMessage(payload); } catch (_) { /* ignore */ }
    }

    // Expose a minimal API the automation bundle (and page code) can call.
    window.__wpf = {
        post: post,
        send: function (type, fields) {
            var msg = Object.assign({ type: type }, fields || {});
            post(msg);
        },
        status: function (text) { post({ type: 'status', text: String(text) }); }
    };

    // ---------------------------------------------------------------
    // Argument formatting — console.log('a', {b:1}, err) -> one string
    // ---------------------------------------------------------------
    var MAX_LEN = 4000;

    function format(value, depth) {
        depth = depth || 0;
        try {
            if (value === null) return 'null';
            if (value === undefined) return 'undefined';

            var t = typeof value;
            if (t === 'string') return value;
            if (t === 'number' || t === 'boolean' || t === 'bigint') return String(value);
            if (t === 'function') return '[Function ' + (value.name || 'anonymous') + ']';
            if (t === 'symbol') return value.toString();

            if (value instanceof Error) {
                return value.name + ': ' + value.message +
                       (value.stack ? '\n' + value.stack : '');
            }
            if (value instanceof Element) {
                return '<' + value.tagName.toLowerCase() +
                       (value.id ? '#' + value.id : '') +
                       (value.className && typeof value.className === 'string'
                            ? '.' + value.className.trim().split(/\s+/).join('.') : '') + '>';
            }
            if (depth > 2) return '[Object]';

            // JSON with a circular-reference guard.
            var seen = new WeakSet();
            return JSON.stringify(value, function (k, v) {
                if (typeof v === 'object' && v !== null) {
                    if (seen.has(v)) return '[Circular]';
                    seen.add(v);
                }
                if (v instanceof Element) return format(v, depth + 1);
                return v;
            });
        } catch (e) {
            return '[Unserialisable: ' + (e && e.message) + ']';
        }
    }

    function joinArgs(args) {
        var out = Array.prototype.slice.call(args).map(function (a) { return format(a, 0); }).join(' ');
        return out.length > MAX_LEN ? out.slice(0, MAX_LEN) + ' …[truncated]' : out;
    }

    // ---------------------------------------------------------------
    // Wrap console methods (originals still fire, so DevTools is intact)
    // ---------------------------------------------------------------
    ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
        var original = console[level] ? console[level].bind(console) : function () { };
        console[level] = function () {
            try { original.apply(null, arguments); } catch (_) { }
            post({
                type: 'console',
                level: level,
                text: joinArgs(arguments),
                source: 'page'
            });
        };
    });

    // console.table / console.trace passthrough (kept simple)
    var origTrace = console.trace ? console.trace.bind(console) : function () { };
    console.trace = function () {
        try { origTrace.apply(null, arguments); } catch (_) { }
        post({ type: 'console', level: 'debug', text: joinArgs(arguments), source: 'trace' });
    };

    // ---------------------------------------------------------------
    // Uncaught errors and rejected promises
    // ---------------------------------------------------------------
    window.addEventListener('error', function (e) {
        post({
            type: 'error',
            text: (e.message || 'Script error') +
                  (e.filename ? '  @ ' + e.filename + ':' + e.lineno + ':' + e.colno : ''),
            source: 'window.onerror'
        });
    }, true);

    window.addEventListener('unhandledrejection', function (e) {
        post({
            type: 'error',
            text: 'Unhandled promise rejection: ' + format(e.reason, 0),
            source: 'unhandledrejection'
        });
    });

    post({ type: 'console', level: 'info', text: 'WPF console bridge attached.', source: 'bridge' });
})();
