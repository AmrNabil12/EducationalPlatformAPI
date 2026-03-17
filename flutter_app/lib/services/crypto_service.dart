import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';
import 'package:cryptography/cryptography.dart' as crypto;
import 'package:pointycastle/export.dart' as pc;

class CryptoService {
  static const MethodChannel _nativeCryptoChannel = MethodChannel(
    'com.example.flutter_app/native_crypto',
  );
  static const String _pagedMagic = 'EDUPG001';
  static const int _pagedHeaderSize = 24;
  static const int _pageNonceSize = 12;
  static const int _pageTagSize = 16;

  final crypto.AesGcm _aes = crypto.AesGcm.with256bits();

  bool get _useNativeAndroidCrypto => !kIsWeb && Platform.isAndroid;

  Future<void> cacheContentKey(String videoId, Uint8List dataKey) async {
    if (!_useNativeAndroidCrypto) return;
    await _nativeCryptoChannel.invokeMethod<void>('storeContentKey', {
      'videoId': videoId,
      'keyB64': base64Encode(dataKey),
    });
  }

  Future<Uint8List?> loadCachedContentKey(String videoId) async {
    if (!_useNativeAndroidCrypto) return null;
    final keyB64 = await _nativeCryptoChannel.invokeMethod<String>('loadContentKey', {
      'videoId': videoId,
    });
    if (keyB64 == null || keyB64.isEmpty) return null;
    return Uint8List.fromList(base64Decode(keyB64));
  }

  Future<void> clearCachedContentKey(String videoId) async {
    if (!_useNativeAndroidCrypto) return;
    await _nativeCryptoChannel.invokeMethod<void>('clearContentKey', {
      'videoId': videoId,
    });
  }

  Future<Uint8List> decryptPagedRange({
    required File encryptedFile,
    required Uint8List dataKey,
    required int start,
    required int end,
  }) async {
    if (end < start) return Uint8List(0);

    if (_useNativeAndroidCrypto) {
      final bytes = await _nativeCryptoChannel.invokeMethod<Uint8List>('decryptPagedRange', {
        'inputPath': encryptedFile.path,
        'keyB64': base64Encode(dataKey),
        'start': start,
        'end': end,
      });

      if (bytes == null) {
        throw Exception('Native paged decrypt returned no data');
      }
      return bytes;
    }

    return _decryptPagedRangeInDart(
      encryptedFile: encryptedFile,
      dataKey: dataKey,
      start: start,
      end: end,
    );
  }

  Future<Uint8List> decryptVideoBytes({
    required Uint8List encryptedBytes,
    required Uint8List dataKey,
    required String videoNonceB64,
  }) async {
    if (encryptedBytes.length < 16) {
      throw Exception('Encrypted data is too short');
    }

    final nonce = base64Decode(videoNonceB64);
    final cipherText = encryptedBytes.sublist(0, encryptedBytes.length - 16);
    final macBytes = encryptedBytes.sublist(encryptedBytes.length - 16);

    final secretKey = crypto.SecretKey(dataKey);
    final secretBox = crypto.SecretBox(
      cipherText,
      nonce: nonce,
      mac: crypto.Mac(macBytes),
    );

    final clear = await _aes.decrypt(secretBox, secretKey: secretKey);
    return Uint8List.fromList(clear);
  }

  Future<File> decryptVideoToFile({
    required Uint8List encryptedBytes,
    required Uint8List dataKey,
    required String videoNonceB64,
    required String outputFileName,
  }) async {
    final clear = await decryptVideoBytes(
      encryptedBytes: encryptedBytes,
      dataKey: dataKey,
      videoNonceB64: videoNonceB64,
    );

    final tempDir = await getTemporaryDirectory();
    final playbackFile = File('${tempDir.path}/$outputFileName');
    await playbackFile.writeAsBytes(clear, flush: true);
    return playbackFile;
  }

  Future<File> decryptVideoFileToFile({
    required File encryptedFile,
    required Uint8List dataKey,
    required String videoNonceB64,
    required String outputFileName,
  }) async {
    if (_useNativeAndroidCrypto) {
      final tempDir = await getTemporaryDirectory();
      final playbackFile = File('${tempDir.path}/$outputFileName');
      try {
        final resultPath = await _nativeCryptoChannel.invokeMethod<String>('decryptFile', {
          'inputPath': encryptedFile.path,
          'outputPath': playbackFile.path,
          'keyB64': base64Encode(dataKey),
          'nonceB64': videoNonceB64,
        });
        return File(resultPath ?? playbackFile.path);
      } on PlatformException catch (e) {
        final message = e.message ?? 'Native decrypt failed';
        if (message.contains('invalid key or corrupted file')) {
          throw Exception('Failed to decrypt video (invalid key or corrupted file)');
        }
        throw Exception(message);
      }
    }

    final nonce = base64Decode(videoNonceB64);
    final tempDir = await getTemporaryDirectory();
    final playbackFile = File('${tempDir.path}/$outputFileName');
    final inputStream = encryptedFile.openRead();
    final sink = playbackFile.openWrite();

    final cipher = pc.GCMBlockCipher(pc.AESEngine())
      ..init(
        false,
        pc.AEADParameters(
          pc.KeyParameter(dataKey),
          128,
          Uint8List.fromList(nonce),
          Uint8List(0),
        ),
      );

    try {
      await for (final chunk in inputStream) {
        final input = Uint8List.fromList(chunk);
        final output = Uint8List(input.length + 32);
        final processed = cipher.processBytes(input, 0, input.length, output, 0);
        if (processed > 0) {
          sink.add(output.sublist(0, processed));
        }
      }

      final finalOutput = Uint8List(32);
      final finalLen = cipher.doFinal(finalOutput, 0);
      if (finalLen > 0) {
        sink.add(finalOutput.sublist(0, finalLen));
      }

      await sink.flush();
      await sink.close();
      return playbackFile;
    } on pc.InvalidCipherTextException {
      try {
        await sink.close();
      } catch (_) {}
      throw Exception('Failed to decrypt video (invalid key or corrupted file)');
    } on RangeError {
      try {
        await sink.close();
      } catch (_) {}
      rethrow;
    } on crypto.SecretBoxAuthenticationError {
      try {
        await sink.close();
      } catch (_) {}
      throw Exception('Failed to decrypt video (invalid key or corrupted file)');
    } catch (_) {
      try {
        await sink.close();
      } catch (_) {}
      rethrow;
    }
  }

  Future<Uint8List> _decryptPagedRangeInDart({
    required File encryptedFile,
    required Uint8List dataKey,
    required int start,
    required int end,
  }) async {
    final raf = await encryptedFile.open();
    try {
      final info = await _readPagedContainerInfo(raf);
      if (info.totalPlainSize <= 0) {
        return Uint8List(0);
      }

      final safeStart = start.clamp(0, info.totalPlainSize - 1);
      final safeEnd = end.clamp(safeStart, info.totalPlainSize - 1);
      final firstPage = safeStart ~/ info.pageSize;
      final lastPage = safeEnd ~/ info.pageSize;
      final output = BytesBuilder(copy: false);
      final secretKey = crypto.SecretKey(dataKey);

      for (var pageIndex = firstPage; pageIndex <= lastPage; pageIndex++) {
        final pageOffset = _pagedHeaderSize + pageIndex * info.recordSize;
        await raf.setPosition(pageOffset);
        final nonce = await raf.read(_pageNonceSize);
        final encryptedPage = await raf.read(info.pageSize + _pageTagSize);
        if (nonce.length != _pageNonceSize || encryptedPage.length != info.pageSize + _pageTagSize) {
          throw Exception('Encrypted paged container is truncated');
        }

        final cipherText = encryptedPage.sublist(0, encryptedPage.length - _pageTagSize);
        final macBytes = encryptedPage.sublist(encryptedPage.length - _pageTagSize);
        final clearPage = await _aes.decrypt(
          crypto.SecretBox(
            cipherText,
            nonce: nonce,
            mac: crypto.Mac(macBytes),
          ),
          secretKey: secretKey,
          aad: _aadForPage(pageIndex),
        );

        final pagePlainStart = pageIndex * info.pageSize;
        final validPlainLength = min(
          info.pageSize,
          info.totalPlainSize - pagePlainStart,
        );
        final localStart = max(0, safeStart - pagePlainStart);
        final localEndExclusive = min(validPlainLength, safeEnd - pagePlainStart + 1);

        if (localEndExclusive > localStart) {
          output.add(clearPage.sublist(localStart, localEndExclusive));
        }
      }

      return output.toBytes();
    } on crypto.SecretBoxAuthenticationError {
      throw Exception('Failed to decrypt paged video (invalid key or corrupted file)');
    } finally {
      await raf.close();
    }
  }

  Future<_PagedContainerInfo> _readPagedContainerInfo(RandomAccessFile raf) async {
    await raf.setPosition(0);
    final header = await raf.read(_pagedHeaderSize);
    if (header.length != _pagedHeaderSize) {
      throw Exception('Encrypted paged container header is incomplete');
    }

    final magic = String.fromCharCodes(header.sublist(0, 8));
    if (magic != _pagedMagic) {
      throw Exception('Encrypted file is not in paged container format');
    }

    final view = ByteData.sublistView(Uint8List.fromList(header));
    final pageSize = view.getUint32(8, Endian.big);
    final pageCount = view.getUint32(12, Endian.big);
    final totalPlainSize = view.getUint64(16, Endian.big);

    return _PagedContainerInfo(
      pageSize: pageSize,
      pageCount: pageCount,
      totalPlainSize: totalPlainSize,
    );
  }

  Uint8List _aadForPage(int index) {
    final data = ByteData(4)..setUint32(0, index, Endian.big);
    return data.buffer.asUint8List();
  }
}

class _PagedContainerInfo {
  final int pageSize;
  final int pageCount;
  final int totalPlainSize;

  const _PagedContainerInfo({
    required this.pageSize,
    required this.pageCount,
    required this.totalPlainSize,
  });

  int get recordSize => 12 + pageSize + 16;
}
