package com.lifechange.jupyteride;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.util.Base64;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.documentfile.provider.DocumentFile;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Jupyter IDE – WebView + durable local assets + offline Pyodide runtime cache
 *
 * Assets root (default):
 *   Android/data/.../files/JupyterIDE/
 *     runtime/pyodide/   – cached Pyodide files (offline after first download)
 *     packages/
 *     fonts/
 *     data/
 *     notebooks/
 *     packages_manifest.txt
 *
 * Optional: user picks a SAF folder that survives uninstall (packages/notebooks copy).
 */
public class MainActivity extends AppCompatActivity {

    public static final String PYODIDE_VERSION = "0.27.0";
    public static final String PYODIDE_CDN = "https://cdn.jsdelivr.net/pyodide/v" + PYODIDE_VERSION + "/full/";

    /** Core files needed to boot pure Python offline */
    private static final String[] RUNTIME_CORE = new String[]{
            "pyodide.js",
            "pyodide.asm.js",
            "pyodide.asm.wasm",
            "python_stdlib.zip",
            "pyodide-lock.json",
            "python_stdlib.zip"
    };

    private WebView webView;
    private ProgressBar progressBar;
    private ValueCallback<Uri[]> filePathCallback;
    private ActivityResultLauncher<Intent> filePickerLauncher;
    private ActivityResultLauncher<Intent> durableFolderLauncher;
    private ActivityResultLauncher<Intent> saveDocLauncher;

    private File rootDir;
    private File packagesDir;
    private File fontsDir;
    private File dataDir;
    private File runtimeDir;
    private File manifestFile;
    private SharedPreferences prefs;
    private final ExecutorService ioPool = Executors.newFixedThreadPool(2);

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        progressBar = findViewById(R.id.progress);
        prefs = getSharedPreferences("jupyteride", MODE_PRIVATE);

        initLocalStorage();
        setupFilePicker();
        setupDurableFolderPicker();
        setupSaveDocPicker();
        setupWebView();

        webView.loadUrl("file:///android_asset/www/index.html");
    }

    private void initLocalStorage() {
        // Prefer user-visible Documents/JupyterIDE when writable
        File base = null;
        String preferred = prefs != null ? prefs.getString("assets_root", "") : "";
        if (preferred != null && !preferred.isEmpty()) {
            File p = new File(preferred);
            if (p.exists() || p.mkdirs()) base = p.getParentFile() != null && p.getName().equals("JupyterIDE")
                    ? p.getParentFile() : p;
            // If preferred points directly to JupyterIDE root
            if (p.getName().equals("JupyterIDE") && (p.exists() || p.mkdirs())) {
                rootDir = p;
                packagesDir = new File(rootDir, "packages");
                fontsDir = new File(rootDir, "fonts");
                dataDir = new File(rootDir, "data");
                runtimeDir = new File(rootDir, "runtime/pyodide");
                File notebooksDir = new File(rootDir, "notebooks");
                packagesDir.mkdirs(); fontsDir.mkdirs(); dataDir.mkdirs();
                runtimeDir.mkdirs(); notebooksDir.mkdirs();
                manifestFile = new File(rootDir, "packages_manifest.txt");
                if (!manifestFile.exists()) {
                    writeText(manifestFile,
                            "# JupyterIDE package inventory\n" +
                            "# name | version | file | source | date | size\n");
                }
                return;
            }
        }
        try {
            File docs = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS);
            File candidate = new File(docs, "JupyterIDE");
            if (candidate.exists() || candidate.mkdirs()) {
                // probe write
                File probe = new File(candidate, ".write_test");
                try (FileOutputStream fos = new FileOutputStream(probe)) {
                    fos.write(1);
                }
                probe.delete();
                base = docs;
            }
        } catch (Exception ignored) {
            base = null;
        }
        if (base == null) {
            base = getExternalFilesDir(null);
            if (base == null) base = getFilesDir();
        }
        rootDir = new File(base, "JupyterIDE");
        packagesDir = new File(rootDir, "packages");
        try {
            if (rootDir.getAbsolutePath().contains("/Documents/")) {
                prefs.edit().putString("assets_root", rootDir.getAbsolutePath()).apply();
            }
        } catch (Exception ignored) {}

        fontsDir = new File(rootDir, "fonts");
        dataDir = new File(rootDir, "data");
        runtimeDir = new File(rootDir, "runtime/pyodide");
        File notebooksDir = new File(rootDir, "notebooks");
        packagesDir.mkdirs();
        fontsDir.mkdirs();
        dataDir.mkdirs();
        runtimeDir.mkdirs();
        notebooksDir.mkdirs();
        manifestFile = new File(rootDir, "packages_manifest.txt");
        if (!manifestFile.exists()) {
            writeText(manifestFile,
                    "# JupyterIDE package inventory\n" +
                    "# name | version | file | source | date | size\n");
        }
    }

    private void setupFilePicker() {
        filePickerLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> {
                    if (filePathCallback == null) return;
                    Uri[] results = null;
                    if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
                        Uri data = result.getData().getData();
                        if (data != null) results = new Uri[]{data};
                    }
                    filePathCallback.onReceiveValue(results);
                    filePathCallback = null;
                }
        );
    }

    private void setupDurableFolderPicker() {
        durableFolderLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> {
                    if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) return;
                    Uri tree = result.getData().getData();
                    if (tree == null) return;
                    final int flags = result.getData().getFlags()
                            & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                    try {
                        getContentResolver().takePersistableUriPermission(tree, flags);
                    } catch (Exception ignored) {}
                    prefs.edit().putString("durable_tree_uri", tree.toString()).apply();
                    ensureDurableSubdirs(tree);
                    Toast.makeText(this, "Durable folder linked", Toast.LENGTH_SHORT).show();
                    webView.post(() -> webView.evaluateJavascript(
                            "window.__onDurableFolderSet && window.__onDurableFolderSet("
                                    + JSONObject.quote(tree.toString()) + ")", null));
                }
        );
    }

    private void ensureDurableSubdirs(Uri tree) {
        try {
            DocumentFile root = DocumentFile.fromTreeUri(this, tree);
            if (root == null) return;
            for (String name : new String[]{"packages", "fonts", "data", "notebooks", "runtime"}) {
                if (root.findFile(name) == null) root.createDirectory(name);
            }
        } catch (Exception ignored) {}
    }


    private void setupSaveDocPicker() {
        saveDocLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> {
                    if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) return;
                    Uri uri = result.getData().getData();
                    if (uri == null) return;
                    try {
                        getContentResolver().takePersistableUriPermission(
                                uri,
                                Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                        );
                    } catch (Exception ignored) {}
                    final String uriStr = uri.toString();
                    webView.post(() -> webView.evaluateJavascript(
                            "window.__onSavePathPicked && window.__onSavePathPicked(" +
                                    JSONObject.quote(uriStr) + ")", null));
                }
        );
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setTextZoom(100);

        webView.addJavascriptInterface(new AndroidBridge(), "AndroidBridge");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                progressBar.setVisibility(View.GONE);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false;
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                try {
                    Uri uri = request.getUrl();
                    if (uri == null) return null;
                    String host = uri.getHost();
                    if (host == null) return null;
                    // Cache + serve ALL Pyodide CDN assets (runtime + packages)
                    if ((host.contains("jsdelivr.net") || host.contains("cdn.jsdelivr.net"))
                            && uri.getPath() != null
                            && uri.getPath().contains("/pyodide/")) {
                        String name = uri.getLastPathSegment();
                        if (name == null || name.isEmpty() || name.contains("..")) return null;
                        File local = new File(runtimeDir, name);
                        if (!local.exists() || local.length() < 64) {
                            // First time: download into assets (full real files)
                            runtimeDir.mkdirs();
                            downloadToFile(uri.toString(), local);
                        }
                        if (local.exists() && local.length() > 0) {
                            String mime = guessMime(name);
                            InputStream is = new FileInputStream(local);
                            return new WebResourceResponse(mime, "utf-8", is);
                        }
                    }
                } catch (Exception ignored) {}
                return null;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback,
                                            FileChooserParams fileChooserParams) {
                if (MainActivity.this.filePathCallback != null) {
                    MainActivity.this.filePathCallback.onReceiveValue(null);
                }
                MainActivity.this.filePathCallback = filePathCallback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                filePickerLauncher.launch(Intent.createChooser(intent, "Select file"));
                return true;
            }
        });
    }

    private static String guessMime(String name) {
        String lower = name.toLowerCase(Locale.US);
        if (lower.endsWith(".js")) return "application/javascript";
        if (lower.endsWith(".wasm")) return "application/wasm";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".zip")) return "application/zip";
        if (lower.endsWith(".data")) return "application/octet-stream";
        String ext = MimeTypeMap.getFileExtensionFromUrl(name);
        String mime = ext != null ? MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) : null;
        return mime != null ? mime : "application/octet-stream";
    }

    private void writeText(File f, String text) {
        try (OutputStreamWriter w = new OutputStreamWriter(new FileOutputStream(f), StandardCharsets.UTF_8)) {
            w.write(text);
        } catch (Exception ignored) {}
    }

    private String readText(File f) {
        try (BufferedReader r = new BufferedReader(
                new InputStreamReader(new FileInputStream(f), StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) {
                sb.append(line).append('\n');
            }
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    private boolean downloadToFile(String urlStr, File dest) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(urlStr);
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(30000);
            conn.setReadTimeout(120000);
            conn.setInstanceFollowRedirects(true);
            int code = conn.getResponseCode();
            if (code >= 400) return false;
            File tmp = new File(dest.getAbsolutePath() + ".part");
            try (InputStream in = conn.getInputStream();
                 FileOutputStream out = new FileOutputStream(tmp)) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
            }
            if (dest.exists()) dest.delete();
            return tmp.renameTo(dest);
        } catch (Exception e) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }


    private void deleteDir(File dir) {
        if (dir == null || !dir.exists()) return;
        File[] list = dir.listFiles();
        if (list != null) {
            for (File f : list) {
                if (f.isDirectory()) deleteDir(f);
                else f.delete();
            }
        }
        dir.delete();
    }

    private void copyDir(File src, File dst) {
        if (src == null || !src.exists()) return;
        dst.mkdirs();
        File[] list = src.listFiles();
        if (list == null) return;
        for (File f : list) {
            File t = new File(dst, f.getName());
            if (f.isDirectory()) {
                copyDir(f, t);
            } else {
                try (InputStream in = new FileInputStream(f); FileOutputStream out = new FileOutputStream(t)) {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
                } catch (Exception ignored) {}
            }
        }
    }

    public class AndroidBridge {

        @JavascriptInterface
        public String getDataRoot() {
            return rootDir.getAbsolutePath();
        }

        @JavascriptInterface
        public String getRuntimeDir() {
            return runtimeDir.getAbsolutePath();
        }

        @JavascriptInterface
        public String getPyodideCdnBase() {
            return PYODIDE_CDN;
        }

        @JavascriptInterface
        public boolean isRuntimeReady() {
            // Need wasm + js + stdlib at minimum
            File wasm = new File(runtimeDir, "pyodide.asm.wasm");
            File js = new File(runtimeDir, "pyodide.js");
            File std = new File(runtimeDir, "python_stdlib.zip");
            return wasm.exists() && wasm.length() > 1000
                    && js.exists() && js.length() > 1000
                    && std.exists() && std.length() > 1000;
        }

        @JavascriptInterface
        public String listMissingRuntime() {
            JSONArray missing = new JSONArray();
            Set<String> need = new HashSet<>(Arrays.asList(
                    "pyodide.js", "pyodide.asm.js", "pyodide.asm.wasm",
                    "python_stdlib.zip", "pyodide-lock.json"
            ));
            for (String name : need) {
                File f = new File(runtimeDir, name);
                if (!f.exists() || f.length() < 100) missing.put(name);
            }
            return missing.toString();
        }

        /** Download one runtime file from CDN into local cache. Returns status JSON. */
        @JavascriptInterface
        public String cacheRuntimeFile(String fileName) {
            JSONObject o = new JSONObject();
            try {
                if (fileName == null || fileName.contains("..") || fileName.contains("/")) {
                    o.put("ok", false);
                    o.put("error", "invalid name");
                    return o.toString();
                }
                File dest = new File(runtimeDir, fileName);
                if (dest.exists() && dest.length() > 100) {
                    o.put("ok", true);
                    o.put("cached", true);
                    o.put("size", dest.length());
                    return o.toString();
                }
                boolean ok = downloadToFile(PYODIDE_CDN + fileName, dest);
                o.put("ok", ok);
                o.put("cached", false);
                o.put("size", dest.exists() ? dest.length() : 0);
                if (ok) {
                    appendManifest("runtime:" + fileName, PYODIDE_VERSION, fileName, "cdn", dest.length());
                }
            } catch (Exception e) {
                try { o.put("ok", false); o.put("error", e.getMessage()); } catch (Exception ignored) {}
            }
            return o.toString();
        }

        /** Download all core runtime files. Blocking – call from worker in JS via status polling or accept wait. */
        @JavascriptInterface
        public String cacheFullRuntime() {
            JSONObject o = new JSONObject();
            JSONArray results = new JSONArray();
            try {
                String[] files = new String[]{
                        "pyodide.js", "pyodide.asm.js", "pyodide.asm.wasm",
                        "python_stdlib.zip", "pyodide-lock.json"
                };
                boolean allOk = true;
                for (String name : files) {
                    File dest = new File(runtimeDir, name);
                    JSONObject one = new JSONObject();
                    one.put("file", name);
                    if (dest.exists() && dest.length() > 100) {
                        one.put("ok", true);
                        one.put("skipped", true);
                    } else {
                        boolean ok = downloadToFile(PYODIDE_CDN + name, dest);
                        one.put("ok", ok);
                        one.put("skipped", false);
                        if (ok) appendManifest("runtime:" + name, PYODIDE_VERSION, name, "cdn", dest.length());
                        if (!ok) allOk = false;
                    }
                    one.put("size", dest.exists() ? dest.length() : 0);
                    results.put(one);
                }
                o.put("ok", allOk);
                o.put("files", results);
                o.put("ready", isRuntimeReady());
            } catch (Exception e) {
                try { o.put("ok", false); o.put("error", e.getMessage()); } catch (Exception ignored) {}
            }
            return o.toString();
        }

        @JavascriptInterface
        public void pickDurableFolder() {
            runOnUiThread(() -> {
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                        | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                        | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                        | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
                durableFolderLauncher.launch(intent);
            });
        }

        @JavascriptInterface
        public String getDurableFolderUri() {
            return prefs.getString("durable_tree_uri", "");
        }

        @JavascriptInterface
        public boolean hasLocalPackage(String name) {
            if (name == null) return false;
            String key = name.toLowerCase(Locale.US).trim();
            String manifest = readText(manifestFile);
            for (String line : manifest.split("\n")) {
                if (line.startsWith("#") || line.trim().isEmpty()) continue;
                String[] parts = line.split("\\|");
                if (parts.length > 0 && parts[0].trim().equalsIgnoreCase(key)) return true;
            }
            File marker = new File(packagesDir, key + ".marker");
            return marker.exists();
        }

        @JavascriptInterface
        public String listLocalPackages() {
            JSONArray arr = new JSONArray();
            try {
                String manifest = readText(manifestFile);
                for (String line : manifest.split("\n")) {
                    if (line.startsWith("#") || line.trim().isEmpty()) continue;
                    String[] parts = line.split("\\|");
                    if (parts.length >= 1) {
                        JSONObject o = new JSONObject();
                        o.put("name", parts[0].trim());
                        if (parts.length > 1) o.put("version", parts[1].trim());
                        if (parts.length > 2) o.put("file", parts[2].trim());
                        arr.put(o);
                    }
                }
            } catch (Exception ignored) {}
            return arr.toString();
        }

        @JavascriptInterface
        public void savePackage(String name, String version, String fileName, String base64, String source) {
            try {
                byte[] data = Base64.decode(base64, Base64.DEFAULT);
                File out = new File(packagesDir, fileName);
                try (FileOutputStream fos = new FileOutputStream(out)) {
                    fos.write(data);
                }
                appendManifest(name, version, fileName, source, data.length);
            } catch (Exception ignored) {}
        }

        private void appendManifest(String name, String version, String file, String source, long size) {
            String date = new SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US).format(new Date());
            String line = name + " | " + version + " | " + file + " | " + source + " | " + date + " | " + size + "\n";
            try (FileOutputStream fos = new FileOutputStream(manifestFile, true)) {
                fos.write(line.getBytes(StandardCharsets.UTF_8));
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public String saveBinaryFile(String relativePath, String base64) {
            try {
                byte[] data = Base64.decode(base64, Base64.DEFAULT);
                File out = new File(rootDir, relativePath);
                File parent = out.getParentFile();
                if (parent != null) parent.mkdirs();
                try (FileOutputStream fos = new FileOutputStream(out)) { fos.write(data); }
                return out.getAbsolutePath();
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public String saveUserFile(String relativePath, String content) {
            try {
                File out = new File(rootDir, relativePath);
                File parent = out.getParentFile();
                if (parent != null) parent.mkdirs();
                writeText(out, content != null ? content : "");
                return out.getAbsolutePath();
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public String readUserFile(String relativePath) {
            try {
                File f = new File(rootDir, relativePath);
                if (!f.exists()) return "";
                return readText(f);
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public String listFolder(String folder) {
            JSONArray arr = new JSONArray();
            try {
                File dir;
                if (folder == null || folder.equals("root")) {
                    dir = rootDir;
                } else if (folder.equals("packages")) {
                    dir = packagesDir;
                } else if (folder.equals("fonts")) {
                    dir = fontsDir;
                } else if (folder.equals("data")) {
                    dir = dataDir;
                } else if (folder.equals("notebooks")) {
                    dir = new File(rootDir, "notebooks");
                } else if (folder.equals("runtime")) {
                    dir = runtimeDir;
                } else {
                    dir = new File(rootDir, folder);
                }
                if (dir == null || !dir.exists()) return arr.toString();
                File[] files = dir.listFiles();
                if (files != null) {
                    for (File f : files) {
                        JSONObject o = new JSONObject();
                        o.put("name", f.getName() + (f.isDirectory() ? "/" : ""));
                        o.put("size", f.isFile() ? f.length() : 0);
                        o.put("dir", f.isDirectory());
                        arr.put(o);
                    }
                }
            } catch (Exception ignored) {}
            return arr.toString();
        }


        @JavascriptInterface
        public String getClipboardText() {
            try {
                ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                if (cm == null || !cm.hasPrimaryClip()) return "";
                ClipData cd = cm.getPrimaryClip();
                if (cd == null || cd.getItemCount() < 1) return "";
                CharSequence cs = cd.getItemAt(0).coerceToText(MainActivity.this);
                return cs != null ? cs.toString() : "";
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public void setClipboardText(String text) {
            try {
                ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                if (cm == null) return;
                cm.setPrimaryClip(ClipData.newPlainText("jupyteride", text != null ? text : ""));
            } catch (Exception ignored) {}
        }

        /** Download any URL into packages/ or runtime/ subfolder */
        @JavascriptInterface
        public String downloadToAssets(String relativeDir, String fileName, String urlStr) {
            JSONObject o = new JSONObject();
            try {
                if (fileName == null || fileName.contains("..") || fileName.contains("/")) {
                    o.put("ok", false); o.put("error", "bad name"); return o.toString();
                }
                File dir = rootDir;
                if ("packages".equals(relativeDir)) dir = packagesDir;
                else if ("runtime".equals(relativeDir)) dir = runtimeDir;
                else if ("notebooks".equals(relativeDir)) dir = new File(rootDir, "notebooks");
                else if ("data".equals(relativeDir)) dir = dataDir;
                else if (relativeDir != null && !relativeDir.isEmpty()) dir = new File(rootDir, relativeDir);
                dir.mkdirs();
                File dest = new File(dir, fileName);
                boolean ok = downloadToFile(urlStr, dest);
                o.put("ok", ok);
                o.put("path", dest.getAbsolutePath());
                o.put("size", dest.exists() ? dest.length() : 0);
                if (ok) {
                    appendManifest(fileName, "file", fileName, urlStr, dest.length());
                }
            } catch (Exception e) {
                try { o.put("ok", false); o.put("error", e.getMessage()); } catch (Exception ignored) {}
            }
            return o.toString();
        }


        @JavascriptInterface
        public void finishActivity() {
            runOnUiThread(() -> MainActivity.this.finish());
        }

        @JavascriptInterface
        public void pickSaveLocation() {
            runOnUiThread(() -> {
                try {
                    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("application/json");
                    intent.putExtra(Intent.EXTRA_TITLE, "notebook.ipynb");
                    saveDocLauncher.launch(intent);
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "Cannot open save dialog", Toast.LENGTH_SHORT).show();
                }
            });
        }

        /** Incremental sync: copy new files from runtimeDir into packages mirror listing */
        @JavascriptInterface
        public void syncAssetsIncremental() {
            try {
                // Ensure notebooks dir exists; mirror runtime file list into manifest if missing entries
                File notebooks = new File(rootDir, "notebooks");
                notebooks.mkdirs();
                if (runtimeDir != null && runtimeDir.exists()) {
                    File[] files = runtimeDir.listFiles();
                    if (files != null) {
                        String man = readText(manifestFile);
                        for (File f : files) {
                            if (!f.isFile() || f.length() < 64) continue;
                            String key = f.getName();
                            if (!man.contains(key)) {
                                appendManifest("cached:" + key, "file", key, "runtime-sync", f.length());
                            }
                        }
                    }
                }
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public String getAssetsRoot() {
            return rootDir != null ? rootDir.getAbsolutePath() : "";
        }

        /** Move / set assets to public Documents or let user pick SAF folder */
        @JavascriptInterface
        public void migrateToPublicOrPick() {
            runOnUiThread(() -> {
                try {
                    File docs = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS);
                    File dest = new File(docs, "JupyterIDE");
                    dest.mkdirs();
                    File probe = new File(dest, ".write_test");
                    try (FileOutputStream fos = new FileOutputStream(probe)) { fos.write(1); }
                    probe.delete();
                    File oldRoot = rootDir;
                    // CUT: copy full tree then delete old if different path
                    if (oldRoot != null && oldRoot.exists()
                            && !oldRoot.getAbsolutePath().equals(dest.getAbsolutePath())) {
                        copyDir(oldRoot, dest);
                        deleteDir(oldRoot);
                    }
                    prefs.edit().putString("assets_root", dest.getAbsolutePath()).apply();
                    rootDir = dest;
                    packagesDir = new File(rootDir, "packages");
                    fontsDir = new File(rootDir, "fonts");
                    dataDir = new File(rootDir, "data");
                    runtimeDir = new File(rootDir, "runtime/pyodide");
                    packagesDir.mkdirs(); fontsDir.mkdirs(); dataDir.mkdirs(); runtimeDir.mkdirs();
                    new File(rootDir, "notebooks").mkdirs();
                    manifestFile = new File(rootDir, "packages_manifest.txt");
                    Toast.makeText(MainActivity.this,
                            "Assets CUT to: " + dest.getAbsolutePath(), Toast.LENGTH_LONG).show();
                    webView.evaluateJavascript(
                            "window.__onAssetsMoved && window.__onAssetsMoved(" +
                                    JSONObject.quote(dest.getAbsolutePath()) + ")", null);
                } catch (Exception e) {
                    // fallback: SAF pick
                    Toast.makeText(MainActivity.this,
                            "Cannot use Documents — pick a folder", Toast.LENGTH_SHORT).show();
                    pickDurableFolder();
                }
            });
        }

        public String readUriAsBase64(String uriString) {
            try {
                Uri uri = Uri.parse(uriString);
                InputStream is = getContentResolver().openInputStream(uri);
                if (is == null) return null;
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = is.read(buf)) != -1) bos.write(buf, 0, n);
                is.close();
                return Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
            } catch (Exception e) {
                return null;
            }
        }
    }

    @Override
    public void onBackPressed() {
        // Ask Web UI about unsaved changes first
        webView.evaluateJavascript(
                "(function(){ try { if (window.requestCloseApp) { requestCloseApp(); return '1'; } } catch(e) {} return '0'; })()",
                value -> {
                    if (value != null && value.contains("0")) {
                        if (webView.canGoBack()) webView.goBack();
                        else MainActivity.super.onBackPressed();
                    }
                }
        );
    }

    @Override
    protected void onDestroy() {
        ioPool.shutdownNow();
        super.onDestroy();
    }
}
