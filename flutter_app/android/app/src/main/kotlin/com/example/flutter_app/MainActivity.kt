package com.example.flutter_app
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.PublicKey
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class MainActivity : FlutterActivity() {
    companion object {
        private const val CHANNEL = "com.example.flutter_app/native_crypto"
        private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
        private const val MASTER_KEY_ALIAS = "content_key_cache_master"
        private const val ASYMMETRIC_KEY_ALIAS = "content_wrapping_rsa"
        private const val PREFS_NAME = "native_crypto_cache"
        private const val AES_GCM_TRANSFORMATION = "AES/GCM/NoPadding"
        private const val RSA_TRANSFORMATION = "RSA/ECB/PKCS1Padding"
        private const val TAG_LENGTH_BITS = 128
        private const val PAGED_MAGIC = "EDUPG001"
        private const val PAGED_HEADER_SIZE = 24L
        private const val PAGE_NONCE_SIZE = 12
        private const val PAGE_TAG_SIZE = 16
    }

    private val cryptoExecutor = Executors.newSingleThreadExecutor()

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL).setMethodCallHandler { call, result ->
            try {
                when (call.method) {
                    "storeContentKey" -> {
                        val videoId = call.argument<String>("videoId")
                        val keyB64 = call.argument<String>("keyB64")
                        if (videoId.isNullOrBlank() || keyB64.isNullOrBlank()) {
                            result.error("invalid_args", "videoId and keyB64 are required", null)
                            return@setMethodCallHandler
                        }

                        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                            result.error("unsupported", "Android Keystore AES caching requires API 23+", null)
                            return@setMethodCallHandler
                        }

                        storeContentKey(videoId, keyB64)
                        result.success(null)
                    }

                    "loadContentKey" -> {
                        val videoId = call.argument<String>("videoId")
                        if (videoId.isNullOrBlank()) {
                            result.error("invalid_args", "videoId is required", null)
                            return@setMethodCallHandler
                        }

                        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                            result.success(null)
                            return@setMethodCallHandler
                        }

                        result.success(loadContentKey(videoId))
                    }

                    "clearContentKey" -> {
                        val videoId = call.argument<String>("videoId")
                        if (videoId.isNullOrBlank()) {
                            result.error("invalid_args", "videoId is required", null)
                            return@setMethodCallHandler
                        }

                        clearContentKey(videoId)
                        result.success(null)
                    }

                    "getOrCreatePublicKeyPem" -> {
                        result.success(getOrCreatePublicKeyPem())
                    }

                    "resetAsymmetricKeyPair" -> {
                        resetAsymmetricKeyPair()
                        result.success(null)
                    }

                    "storeWrappedContentKey" -> {
                        val videoId = call.argument<String>("videoId")
                        val encryptedDataKeyB64 = call.argument<String>("encryptedDataKeyB64")
                        if (videoId.isNullOrBlank() || encryptedDataKeyB64.isNullOrBlank()) {
                            result.error("invalid_args", "videoId and encryptedDataKeyB64 are required", null)
                            return@setMethodCallHandler
                        }

                        storeWrappedContentKey(videoId, encryptedDataKeyB64)
                        result.success(null)
                    }

                    "decryptWrappedDataKey" -> {
                        val encryptedDataKeyB64 = call.argument<String>("encryptedDataKeyB64")
                        if (encryptedDataKeyB64.isNullOrBlank()) {
                            result.error("invalid_args", "encryptedDataKeyB64 is required", null)
                            return@setMethodCallHandler
                        }

                        result.success(decryptWrappedDataKey(encryptedDataKeyB64))
                    }

                    "decryptFile" -> {
                        val inputPath = call.argument<String>("inputPath")
                        val outputPath = call.argument<String>("outputPath")
                        val keyB64 = call.argument<String>("keyB64")
                        val nonceB64 = call.argument<String>("nonceB64")

                        if (inputPath.isNullOrBlank() || outputPath.isNullOrBlank() || keyB64.isNullOrBlank() || nonceB64.isNullOrBlank()) {
                            result.error("invalid_args", "inputPath, outputPath, keyB64, nonceB64 are required", null)
                            return@setMethodCallHandler
                        }

                        cryptoExecutor.execute {
                            try {
                                val finalPath = decryptFile(inputPath, outputPath, keyB64, nonceB64)
                                runOnUiThread { result.success(finalPath) }
                            } catch (e: Exception) {
                                runOnUiThread {
                                    result.error("native_crypto_error", e.message, null)
                                }
                            }
                        }
                    }

                    "decryptPagedRange" -> {
                        val inputPath = call.argument<String>("inputPath")
                        val keyB64 = call.argument<String>("keyB64")
                        val start = call.argument<Number>("start")?.toLong()
                        val end = call.argument<Number>("end")?.toLong()

                        if (inputPath.isNullOrBlank() || keyB64.isNullOrBlank() || start == null || end == null) {
                            result.error("invalid_args", "inputPath, keyB64, start, end are required", null)
                            return@setMethodCallHandler
                        }

                        cryptoExecutor.execute {
                            try {
                                val clearBytes = decryptPagedRange(inputPath, keyB64, start, end)
                                runOnUiThread { result.success(clearBytes) }
                            } catch (e: Exception) {
                                runOnUiThread {
                                    result.error("native_crypto_error", e.message, null)
                                }
                            }
                        }
                    }

                    else -> result.notImplemented()
                }
            } catch (e: Exception) {
                result.error("native_crypto_error", e.message, null)
            }
        }
    }

    private fun getOrCreateMasterKey(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }
        val existing = keyStore.getKey(MASTER_KEY_ALIAS, null) as? SecretKey
        if (existing != null) return existing

        val keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER)
        val spec = KeyGenParameterSpec.Builder(
            MASTER_KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .build()

        keyGenerator.init(spec)
        return keyGenerator.generateKey()
    }

    private fun getOrCreateAsymmetricPublicKey(): PublicKey {
        val keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }
        val certificate = keyStore.getCertificate(ASYMMETRIC_KEY_ALIAS)
        if (certificate != null) {
            return certificate.publicKey
        }

        val keyPairGenerator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, KEYSTORE_PROVIDER)
        val spec = KeyGenParameterSpec.Builder(
            ASYMMETRIC_KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setKeySize(2048)
            .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA512)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_PKCS1)
            .build()

        keyPairGenerator.initialize(spec)
        return keyPairGenerator.generateKeyPair().public
    }

    private fun getAsymmetricPrivateKey(): PrivateKey {
        getOrCreateAsymmetricPublicKey()
        val keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }
        return keyStore.getKey(ASYMMETRIC_KEY_ALIAS, null) as? PrivateKey
            ?: throw IllegalStateException("Asymmetric private key is missing")
    }

    private fun getOrCreatePublicKeyPem(): String {
        val publicKey = getOrCreateAsymmetricPublicKey()
        return pemEncodePublicKey(publicKey.encoded)
    }

    private fun resetAsymmetricKeyPair() {
        val keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }
        if (keyStore.containsAlias(ASYMMETRIC_KEY_ALIAS)) {
            keyStore.deleteEntry(ASYMMETRIC_KEY_ALIAS)
        }
    }

    private fun pemEncodePublicKey(encoded: ByteArray): String {
        val base64 = Base64.encodeToString(encoded, Base64.NO_WRAP)
        val body = base64.chunked(64).joinToString("\n")
        return "-----BEGIN PUBLIC KEY-----\n$body\n-----END PUBLIC KEY-----"
    }

    private fun storeContentKey(videoId: String, keyB64: String) {
        val keyBytes = Base64.decode(keyB64, Base64.DEFAULT)
        val cipher = Cipher.getInstance(AES_GCM_TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateMasterKey())
        val encrypted = cipher.doFinal(keyBytes)
        val iv = cipher.iv

        val payload = Base64.encodeToString(iv, Base64.NO_WRAP) + ":" +
            Base64.encodeToString(encrypted, Base64.NO_WRAP)

        getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
            .edit()
            .putString("content_key_$videoId", payload)
            .apply()
    }

    private fun loadContentKey(videoId: String): String? {
        val payload = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
            .getString("content_key_$videoId", null) ?: return null

        val parts = payload.split(":", limit = 2)
        if (parts.size != 2) return null

        val iv = Base64.decode(parts[0], Base64.DEFAULT)
        val encrypted = Base64.decode(parts[1], Base64.DEFAULT)

        val cipher = Cipher.getInstance(AES_GCM_TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateMasterKey(), GCMParameterSpec(TAG_LENGTH_BITS, iv))
        val clear = cipher.doFinal(encrypted)
        return Base64.encodeToString(clear, Base64.NO_WRAP)
    }

    private fun clearContentKey(videoId: String) {
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
            .edit()
            .remove("content_key_$videoId")
            .apply()
    }

    private fun storeWrappedContentKey(videoId: String, encryptedDataKeyB64: String) {
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
            .edit()
            .putString("wrapped_key_$videoId", encryptedDataKeyB64)
            .apply()
    }

    private fun decryptWrappedDataKey(encryptedDataKeyB64: String): String {
        val cipher = Cipher.getInstance(RSA_TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, getAsymmetricPrivateKey())
        val clear = cipher.doFinal(Base64.decode(encryptedDataKeyB64, Base64.DEFAULT))
        return Base64.encodeToString(clear, Base64.NO_WRAP)
    }

    private fun decryptFile(inputPath: String, outputPath: String, keyB64: String, nonceB64: String): String {
        val inputFile = File(inputPath)
        val outputFile = File(outputPath)
        outputFile.parentFile?.mkdirs()

        val keyBytes = Base64.decode(keyB64, Base64.DEFAULT)
        try {
            if (isPagedContainer(inputFile)) {
                decryptPagedFile(inputFile, outputFile, keyBytes)
            } else {
                val nonce = Base64.decode(nonceB64, Base64.DEFAULT)
                val payload = inputFile.readBytes()
                val cipher = Cipher.getInstance(AES_GCM_TRANSFORMATION)
                cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(keyBytes, "AES"), GCMParameterSpec(TAG_LENGTH_BITS, nonce))
                val clear = cipher.doFinal(payload)
                FileOutputStream(outputFile).use { output ->
                    output.write(clear)
                    output.flush()
                }
            }
            return outputFile.path
        } catch (e: Exception) {
            outputFile.delete()
            if (e.message?.contains("AEADBadTag") == true) {
                throw Exception("Failed to decrypt video (invalid key or corrupted file)")
            }
            throw e
        }
    }

    private fun decryptPagedRange(inputPath: String, keyB64: String, start: Long, end: Long): ByteArray {
        val keyBytes = Base64.decode(keyB64, Base64.DEFAULT)
        RandomAccessFile(inputPath, "r").use { raf ->
            val info = readPagedContainerInfo(raf)
            if (info.totalPlainSize <= 0L) {
                return ByteArray(0)
            }

            val safeStart = start.coerceIn(0L, info.totalPlainSize - 1)
            val safeEnd = end.coerceIn(safeStart, info.totalPlainSize - 1)
            val firstPage = (safeStart / info.pageSize.toLong()).toInt()
            val lastPage = (safeEnd / info.pageSize.toLong()).toInt()
                val length = (safeEnd - safeStart + 1).toInt()
                val output = ByteArray(length)
                var bytesWritten = 0

                for (pageIndex in firstPage..lastPage) {
                    val pageOffset = PAGED_HEADER_SIZE + pageIndex.toLong() * info.recordSize
                    raf.seek(pageOffset)

                    val nonce = ByteArray(PAGE_NONCE_SIZE)
                    raf.readFully(nonce)

                    val encryptedPage = ByteArray(info.pageSize + PAGE_TAG_SIZE)
                    raf.readFully(encryptedPage)

                    val clearPage = decryptPagedPage(keyBytes, pageIndex, nonce, encryptedPage)
                    val pagePlainStart = pageIndex.toLong() * info.pageSize.toLong()
                    val validPlainLength = minOf(info.pageSize.toLong(), info.totalPlainSize - pagePlainStart).toInt()
                    val localStart = maxOf(0L, safeStart - pagePlainStart).toInt()
                    val localEndExclusive = minOf(validPlainLength.toLong(), safeEnd - pagePlainStart + 1).toInt()

                    if (localEndExclusive > localStart) {
                        val toWrite = localEndExclusive - localStart
                        System.arraycopy(clearPage, localStart, output, bytesWritten, toWrite)
                        bytesWritten += toWrite
                    }
                }

                return output
        }
    }

    private fun decryptPagedFile(inputFile: File, outputFile: File, keyBytes: ByteArray) {
        RandomAccessFile(inputFile, "r").use { raf ->
            val info = readPagedContainerInfo(raf)

            FileOutputStream(outputFile).use { output ->
                for (pageIndex in 0 until info.pageCount) {
                    val pageOffset = PAGED_HEADER_SIZE + pageIndex.toLong() * info.recordSize
                    raf.seek(pageOffset)

                    val nonce = ByteArray(PAGE_NONCE_SIZE)
                    raf.readFully(nonce)

                    val encryptedPage = ByteArray(info.pageSize + PAGE_TAG_SIZE)
                    raf.readFully(encryptedPage)

                    val clearPage = decryptPagedPage(keyBytes, pageIndex, nonce, encryptedPage)
                    val pagePlainStart = pageIndex.toLong() * info.pageSize.toLong()
                    val validPlainLength = minOf(info.pageSize.toLong(), info.totalPlainSize - pagePlainStart).toInt()
                    if (validPlainLength > 0) {
                        output.write(clearPage, 0, validPlainLength)
                    }
                }
                output.flush()
            }
        }
    }

    private fun decryptPagedPage(keyBytes: ByteArray, pageIndex: Int, nonce: ByteArray, encryptedPage: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(AES_GCM_TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(keyBytes, "AES"), GCMParameterSpec(TAG_LENGTH_BITS, nonce))
        cipher.updateAAD(aadForPage(pageIndex))
        return cipher.doFinal(encryptedPage)
    }

    private fun readPagedContainerInfo(raf: RandomAccessFile): PagedContainerInfo {
        raf.seek(0L)
        val header = ByteArray(PAGED_HEADER_SIZE.toInt())
        raf.readFully(header)

        val magic = String(header.copyOfRange(0, 8), Charsets.US_ASCII)
        if (magic != PAGED_MAGIC) {
            throw IllegalStateException("Encrypted file is not in paged container format")
        }

        val buffer = ByteBuffer.wrap(header).order(ByteOrder.BIG_ENDIAN)
        buffer.position(8)
        val pageSize = buffer.int
        val pageCount = buffer.int
        val totalPlainSize = buffer.long

        return PagedContainerInfo(pageSize, pageCount, totalPlainSize)
    }

    private fun aadForPage(index: Int): ByteArray {
        return ByteBuffer.allocate(4)
            .order(ByteOrder.BIG_ENDIAN)
            .putInt(index)
            .array()
    }

    private fun isPagedContainer(inputFile: File): Boolean {
        RandomAccessFile(inputFile, "r").use { raf ->
            if (raf.length() < PAGED_HEADER_SIZE) return false
            val header = ByteArray(8)
            raf.readFully(header)
            return String(header, Charsets.US_ASCII) == PAGED_MAGIC
        }
    }

    private data class PagedContainerInfo(
        val pageSize: Int,
        val pageCount: Int,
        val totalPlainSize: Long,
    ) {
        val recordSize: Long
            get() = PAGE_NONCE_SIZE.toLong() + pageSize.toLong() + PAGE_TAG_SIZE.toLong()
    }
}
