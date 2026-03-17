import 'dart:convert';
import 'dart:io';

import 'package:basic_utils/basic_utils.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter/services.dart';
import 'package:pointycastle/export.dart';

class KeyPairPem {
  final String publicKeyPem;
  final String privateKeyPem;

  const KeyPairPem({
    required this.publicKeyPem,
    required this.privateKeyPem,
  });
}

class KeyService {
  static const _publicKeyPemKey = 'rsa_public_key_pem';
  static const _privateKeyPemKey = 'rsa_private_key_pem';
  static const MethodChannel _nativeCryptoChannel = MethodChannel(
    'com.example.flutter_app/native_crypto',
  );

  final FlutterSecureStorage _storage = const FlutterSecureStorage();

  bool get _useNativeAndroidKeys => !kIsWeb && Platform.isAndroid;

  Future<KeyPairPem> getOrCreateKeyPair() async {
    if (_useNativeAndroidKeys) {
      final publicPem = await _nativeCryptoChannel.invokeMethod<String>('getOrCreatePublicKeyPem');
      if (publicPem == null || publicPem.isEmpty) {
        throw Exception('Failed to get Android Keystore public key');
      }

      return KeyPairPem(publicKeyPem: publicPem, privateKeyPem: '');
    }

    final publicPem = await _storage.read(key: _publicKeyPemKey);
    final privatePem = await _storage.read(key: _privateKeyPemKey);

    if (publicPem != null && publicPem.isNotEmpty && privatePem != null && privatePem.isNotEmpty) {
      return KeyPairPem(publicKeyPem: publicPem, privateKeyPem: privatePem);
    }

    final pair = CryptoUtils.generateRSAKeyPair();
    final publicKey = pair.publicKey as RSAPublicKey;
    final privateKey = pair.privateKey as RSAPrivateKey;

    final generatedPublicPem = CryptoUtils.encodeRSAPublicKeyToPemPkcs1(publicKey);
    final generatedPrivatePem = CryptoUtils.encodeRSAPrivateKeyToPemPkcs1(privateKey);

    await _storage.write(key: _publicKeyPemKey, value: generatedPublicPem);
    await _storage.write(key: _privateKeyPemKey, value: generatedPrivatePem);

    return KeyPairPem(
      publicKeyPem: generatedPublicPem,
      privateKeyPem: generatedPrivatePem,
    );
  }

  Future<String> getPublicKeyPem() async {
    final pair = await getOrCreateKeyPair();
    return pair.publicKeyPem;
  }

  Future<void> resetKeyPair() async {
    if (_useNativeAndroidKeys) {
      await _nativeCryptoChannel.invokeMethod<void>('resetAsymmetricKeyPair');
      return;
    }

    await _storage.delete(key: _publicKeyPemKey);
    await _storage.delete(key: _privateKeyPemKey);
  }

  Future<bool> cacheWrappedContentKey(String videoId, String encryptedDataKeyB64) async {
    if (!_useNativeAndroidKeys) return false;
    await _nativeCryptoChannel.invokeMethod<void>('storeWrappedContentKey', {
      'videoId': videoId,
      'encryptedDataKeyB64': encryptedDataKeyB64,
    });
    return true;
  }

  Future<Uint8List> decryptDataKeyFromBase64(String encryptedDataKeyB64) async {
    if (_useNativeAndroidKeys) {
      final clearKeyB64 = await _nativeCryptoChannel.invokeMethod<String>('decryptWrappedDataKey', {
        'encryptedDataKeyB64': encryptedDataKeyB64,
      });
      if (clearKeyB64 == null || clearKeyB64.isEmpty) {
        throw Exception('Failed to unwrap content key using Android Keystore');
      }
      return Uint8List.fromList(base64Decode(clearKeyB64));
    }

    final pair = await getOrCreateKeyPair();
    final privateKey = CryptoUtils.rsaPrivateKeyFromPem(pair.privateKeyPem);
    final encryptedBytes = base64Decode(encryptedDataKeyB64);
    return _rsaDecrypt(privateKey, Uint8List.fromList(encryptedBytes));
  }

  Uint8List _rsaDecrypt(RSAPrivateKey privateKey, Uint8List cipherText) {
    final engine = PKCS1Encoding(RSAEngine())
      ..init(false, PrivateKeyParameter<RSAPrivateKey>(privateKey));
    return _processInBlocks(engine, cipherText);
  }

  Uint8List _processInBlocks(AsymmetricBlockCipher engine, Uint8List input) {
    final output = <int>[];
    var offset = 0;

    while (offset < input.length) {
      final end = (offset + engine.inputBlockSize < input.length)
          ? offset + engine.inputBlockSize
          : input.length;
      final chunk = input.sublist(offset, end);
      output.addAll(engine.process(Uint8List.fromList(chunk)));
      offset = end;
    }

    return Uint8List.fromList(output);
  }
}
