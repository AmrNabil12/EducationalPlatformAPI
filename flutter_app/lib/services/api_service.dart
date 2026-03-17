import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

import '../models.dart';

class ApiService {
  static const String baseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'https://educationalplatformapi-production.up.railway.app',
  );

  Uri _uri(String path) => Uri.parse('$baseUrl$path');

  Uri plainVideoUri(String videoId) => _uri('/videos/$videoId/plain');

  Future<StudentSession> login({
    required String serial,
    required String deviceId,
    required String publicKeyPem,
  }) async {
    final response = await http.post(
      _uri('/auth/login'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'serial': serial,
        'deviceId': deviceId,
        'publicKeyPem': publicKeyPem,
      }),
    );

    final data = _decodeMap(response.body);
    if (response.statusCode >= 400) {
      throw Exception(data['error'] ?? 'Login failed');
    }
    return StudentSession.fromJson(data);
  }

  Future<List<MonthGroup>> fetchMonths({required String token}) async {
    final response = await http.get(
      _uri('/videos'),
      headers: {
        'Authorization': 'Bearer $token',
      },
    );

    final data = _decodeMap(response.body);
    if (response.statusCode >= 400) {
      throw Exception(data['error'] ?? 'Failed to load videos');
    }

    final months = (data['months'] as List<dynamic>? ?? [])
        .map((m) => MonthGroup.fromJson(m as Map<String, dynamic>))
        .toList();
    return months;
  }

  Future<LicenseResponse> requestLicense({
    required String token,
    required String videoId,
    required String publicKeyPem,
  }) async {
    final response = await http.post(
      _uri('/videos/$videoId/license'),
      headers: {
        'Authorization': 'Bearer $token',
        'Content-Type': 'application/json',
      },
      body: jsonEncode({
        'publicKeyPem': publicKeyPem,
      }),
    );

    final data = _decodeMap(response.body);
    if (response.statusCode >= 400) {
      throw Exception(data['error'] ?? 'Failed to get playback license');
    }
    return LicenseResponse.fromJson(data);
  }

  Future<Uint8List> downloadEncryptedContent({
    required String url,
    required bool requiresAuthForContent,
    required String token,
  }) async {
    final headers = <String, String>{};
    if (requiresAuthForContent) {
      headers['Authorization'] = 'Bearer $token';
    }

    final response = await http.get(_resolveContentUri(url), headers: headers);
    if (response.statusCode >= 400) {
      throw Exception('Failed to download encrypted video (${response.statusCode})');
    }
    return response.bodyBytes;
  }

  Future<File> downloadEncryptedContentToFile({
    required String url,
    required bool requiresAuthForContent,
    required String token,
    required String outputFileName,
    void Function(double progress)? onProgress,
  }) async {
    final headers = <String, String>{};
    if (requiresAuthForContent) {
      headers['Authorization'] = 'Bearer $token';
    }

    final client = http.Client();
    try {
      final request = http.Request('GET', _resolveContentUri(url));
      request.headers.addAll(headers);
      final response = await client.send(request);

      if (response.statusCode >= 400) {
        throw Exception('Failed to download encrypted video (${response.statusCode})');
      }

      final tempDir = await getTemporaryDirectory();
      final encryptedFile = File('${tempDir.path}/$outputFileName');
      final sink = encryptedFile.openWrite();
      final total = response.contentLength ?? -1;
      var received = 0;
      onProgress?.call(0);

      await for (final chunk in response.stream) {
        sink.add(chunk);
        received += chunk.length;
        if (total > 0) {
          final value = (received / total).clamp(0.0, 1.0);
          onProgress?.call(value);
        }
      }

      await sink.flush();
      await sink.close();
      onProgress?.call(1);

      return encryptedFile;
    } finally {
      client.close();
    }
  }

  Uri _resolveContentUri(String url) {
    final uri = Uri.parse(url);

    // Relative path from backend (preferred): "/storage/<file>.enc"
    if (!uri.hasScheme) {
      final normalized = url.startsWith('/') ? url : '/$url';
      return _uri(normalized);
    }

    // Backward compatibility: if backend returns localhost absolute URL,
    // rewrite host to current API base host so emulators/devices can access it.
    final base = Uri.parse(baseUrl);
    if (uri.host == 'localhost' || uri.host == '127.0.0.1') {
      return uri.replace(
        scheme: base.scheme,
        host: base.host,
        port: base.hasPort ? base.port : null,
      );
    }

    return uri;
  }

  Map<String, dynamic> _decodeMap(String raw) {
    if (raw.isEmpty) return <String, dynamic>{};
    final decoded = jsonDecode(raw);
    if (decoded is Map<String, dynamic>) return decoded;
    return <String, dynamic>{};
  }
}
