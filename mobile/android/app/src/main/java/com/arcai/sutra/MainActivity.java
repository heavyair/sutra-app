package com.arcai.sutra;

import android.content.Context;
import android.os.Bundle;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 打印桥：App 内 WebView 没有 window.print()，前端调 AndroidPrint.print()
        // 走系统打印对话框（可“另存为 PDF”）。用户点打印时调用即可，与页面加载时机无关。
        try {
            WebView wv = getBridge().getWebView();
            wv.addJavascriptInterface(new PrintBridge(), "AndroidPrint");
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    class PrintBridge {
        @JavascriptInterface
        public void print() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        WebView wv = getBridge().getWebView();
                        String jobName = "抄经作品";
                        PrintDocumentAdapter adapter = wv.createPrintDocumentAdapter(jobName);
                        PrintManager pm = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                        if (pm != null) {
                            pm.print(jobName, adapter, new PrintAttributes.Builder().build());
                        }
                    } catch (Exception e) {
                        e.printStackTrace();
                    }
                }
            });
        }
    }
}
