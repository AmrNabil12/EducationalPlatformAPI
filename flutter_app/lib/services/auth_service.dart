import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../models.dart';

class AuthService {
  static const _tokenKey = 'auth_token';
  static const _serialKey = 'student_serial';
  static const _deviceIdKey = 'device_id';
  static const _displayNameKey = 'student_display_name';

  final FlutterSecureStorage _storage = const FlutterSecureStorage();

  Future<void> saveSession(StudentSession session, {String? displayName}) async {
    await _storage.write(key: _tokenKey, value: session.token);
    await _storage.write(key: _serialKey, value: session.serial);
    await _storage.write(key: _deviceIdKey, value: session.deviceId);
    if (displayName != null && displayName.trim().isNotEmpty) {
      await _storage.write(key: _displayNameKey, value: displayName.trim());
    }
  }

  Future<String?> getToken() => _storage.read(key: _tokenKey);

  Future<String?> getDisplayName() => _storage.read(key: _displayNameKey);

  Future<void> clearSession() async {
    await _storage.delete(key: _tokenKey);
    await _storage.delete(key: _serialKey);
    await _storage.delete(key: _displayNameKey);
  }
}
