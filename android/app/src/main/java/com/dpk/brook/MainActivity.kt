package com.dpk.brook

import android.Manifest
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.getcapacitor.BridgeActivity
import com.getcapacitor.CapConfig

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(BrookPlayerPlugin::class.java)

        // Test builds only: `am start -e brook_url http://localhost:5199` points the app at a test server
        // and turns on WebView debugging, so the web UI can be driven over USB. A normal install ignores it.
        val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        val testUrl = intent?.getStringExtra("brook_url")
        if (debuggable && !testUrl.isNullOrEmpty()) {
            config = CapConfig.Builder(this)
                .setServerUrl(testUrl)
                .setAndroidScheme("http")
                .setAllowMixedContent(true)
                .setWebContentsDebuggingEnabled(true)
                .create()
        }

        super.onCreate(savedInstanceState)
        askForNotifications()
    }

    // Android 13+: without this the lock-screen and notification player are hidden.
    private fun askForNotifications() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }
}
