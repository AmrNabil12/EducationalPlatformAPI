import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:path_provider/path_provider.dart';

import '../models.dart';
import 'api_service.dart';
import 'crypto_service.dart';
import 'key_service.dart';

class PreparedPlayback {
  final File? file;
  final Uri? networkUri;
  final Map<String, String>? httpHeaders;
  final VideoItem video;

  const PreparedPlayback({
    this.file,
    this.networkUri,
    this.httpHeaders,
    required this.video,
  }) : assert(file != null || networkUri != null, 'Either file or networkUri must be provided');
}

class PlaybackService {
  final ApiService apiService;
  final KeyService keyService;
  final CryptoService cryptoService;
  final Map<String, _PagedPlaybackProxy> _pagedProxies = <String, _PagedPlaybackProxy>{};

  PlaybackService({
    required this.apiService,
    required this.keyService,
    required this.cryptoService,
  });

  Future<Directory> _sessionDir() async {
    final base = await getApplicationSupportDirectory();
    final dir = Directory('${base.path}/video_sessions');
    if (!await dir.exists()) {
      await dir.create(recursive: true);
    }
    return dir;
  }

  Future<File> _encryptedFileFor(String videoId) async {
    final dir = await _sessionDir();
    return File('${dir.path}/$videoId.enc');
  }

  Future<File> _licenseFileFor(String videoId) async {
    final dir = await _sessionDir();
    return File('${dir.path}/$videoId.license.json');
  }

  Future<String> getSessionDirectoryPath() async {
    final dir = await _sessionDir();
    return dir.path;
  }

  Future<String> getSessionDebugPath(String videoId) async {
    final dir = await _sessionDir();
    final encrypted = await _encryptedFileFor(videoId);
    final license = await _licenseFileFor(videoId);

    Future<String> describe(File file) async {
      final exists = await file.exists();
      if (!exists) return '${file.path} (missing)';
      try {
        final len = await file.length();
        return '${file.path} ($len bytes)';
      } catch (_) {
        return '${file.path} (exists, size unavailable)';
      }
    }

    final encryptedDesc = await describe(encrypted);
    final licenseDesc = await describe(license);

    return 'Storage folder: ${dir.path}\nEncrypted file: $encryptedDesc\nLicense file: $licenseDesc';
  }

  Future<bool> hasDownloadedSession(String videoId) async {
    final license = await _licenseFileFor(videoId);
    final encrypted = await _encryptedFileFor(videoId);
    return await license.exists() && await encrypted.exists();
  }

  Future<void> deleteSession(String videoId) async {
    final encryptedFile = await _encryptedFileFor(videoId);
    final licenseFile = await _licenseFileFor(videoId);

    if (await encryptedFile.exists()) {
      await encryptedFile.delete();
    }
    if (await licenseFile.exists()) {
      await licenseFile.delete();
    }

    await cryptoService.clearCachedContentKey(videoId);

    final proxy = _pagedProxies.remove(videoId);
    if (proxy != null) {
      await proxy.close();
    }
  }

  Future<void> downloadSession({
    required String token,
    required VideoItem video,
    void Function(double progress)? onProgress,
  }) async {
    final publicKeyPem = await keyService.getPublicKeyPem();
    final license = await apiService.requestLicense(
      token: token,
      videoId: video.id,
      publicKeyPem: publicKeyPem,
    );

    if (!license.isPaged) {
      throw Exception(
        'This video is not using the new on-demand paged encryption format yet. Regenerate the encrypted assets first.',
      );
    }

    final tempEncrypted = await apiService.downloadEncryptedContentToFile(
      url: license.contentUrl,
      requiresAuthForContent: license.requiresAuthForContent,
      token: token,
      outputFileName: '${video.id}.enc',
      onProgress: onProgress,
    );

    final targetEncrypted = await _encryptedFileFor(video.id);
    final targetLicense = await _licenseFileFor(video.id);

    try {
      await tempEncrypted.copy(targetEncrypted.path);
      await _prepareAndCacheContentKey(video.id, license.encryptedDataKeyB64);

      final licensePayload = {
        'videoId': license.videoId,
        'storageMode': license.storageMode,
        'encryptedDataKeyB64': license.encryptedDataKeyB64,
        'contentUrl': license.contentUrl,
        'requiresAuthForContent': license.requiresAuthForContent,
        'totalPlainSize': license.totalPlainSize,
        'pageSize': license.pageSize,
        'pageCount': license.pageCount,
      };

      await targetLicense.writeAsString(jsonEncode(licensePayload), flush: true);
    } finally {
      if (await tempEncrypted.exists()) {
        await tempEncrypted.delete();
      }
    }
  }

  Future<PreparedPlayback> openDownloadedSession({
    required VideoItem video,
    String? token,
    bool allowLicenseRefreshRecovery = true,
    bool allowKeyResetRecovery = true,
  }) async {
    final encryptedFile = await _encryptedFileFor(video.id);
    final licenseFile = await _licenseFileFor(video.id);

    if (!await encryptedFile.exists() || !await licenseFile.exists()) {
      throw Exception('Please download this session first.');
    }

    final raw = await licenseFile.readAsString();
    if (raw.trim().isEmpty) {
      throw Exception(
        'Downloaded session metadata is empty. Files were kept for inspection.\n${await getSessionDebugPath(video.id)}',
      );
    }

    final decoded = jsonDecode(raw) as Map<String, dynamic>;
    final encryptedDataKeyB64 = decoded['encryptedDataKeyB64'] as String? ?? '';
    final storageMode = (decoded['storageMode'] as String? ?? '').toLowerCase();
    final totalPlainSize = decoded['totalPlainSize'] as int? ?? 0;
    final pageSize = decoded['pageSize'] as int? ?? 0;
    final pageCount = decoded['pageCount'] as int? ?? 0;

    if (storageMode != 'paged' || encryptedDataKeyB64.isEmpty || totalPlainSize <= 0 || pageSize <= 0 || pageCount <= 0) {
      throw Exception(
        'Downloaded session metadata is missing required paged fields. Files were kept for inspection.\n${await getSessionDebugPath(video.id)}',
      );
    }

    Uint8List? dataKey = await cryptoService.loadCachedContentKey(video.id);
    try {
      if (dataKey == null) {
        dataKey = await keyService.decryptDataKeyFromBase64(encryptedDataKeyB64);
        await cryptoService.cacheContentKey(video.id, dataKey);
      }
    } catch (e) {
      if (token != null && token.isNotEmpty && allowKeyResetRecovery) {
        try {
          await keyService.resetKeyPair();
          await _refreshLicenseOnly(token: token, video: video);
          return await openDownloadedSession(
            video: video,
            token: token,
            allowLicenseRefreshRecovery: false,
            allowKeyResetRecovery: false,
          );
        } catch (_) {
          throw Exception(
            'Failed to unwrap playback key on this device. Files were kept for inspection.\n${await getSessionDebugPath(video.id)}',
          );
        }
      }
      rethrow;
    }

    var proxy = _pagedProxies[video.id];
    if (proxy == null || !proxy.matches(
      encryptedFile: encryptedFile,
      totalPlainSize: totalPlainSize,
      pageSize: pageSize,
      pageCount: pageCount,
      dataKey: dataKey,
    )) {
      await proxy?.close();
      proxy = _PagedPlaybackProxy(
        videoId: video.id,
        encryptedFile: encryptedFile,
        totalPlainSize: totalPlainSize,
        pageSize: pageSize,
        pageCount: pageCount,
        dataKey: dataKey,
        cryptoService: cryptoService,
      );
      await proxy.start();
      _pagedProxies[video.id] = proxy;
    }

    try {
      await proxy.prewarm();
      return PreparedPlayback(video: video, networkUri: proxy.playbackUri);
    } catch (e) {
      await cryptoService.clearCachedContentKey(video.id);
      if (token != null && token.isNotEmpty && allowLicenseRefreshRecovery) {
        try {
          await _refreshLicenseOnly(token: token, video: video);
          return await openDownloadedSession(
            video: video,
            token: token,
            allowLicenseRefreshRecovery: false,
            allowKeyResetRecovery: allowKeyResetRecovery,
          );
        } catch (_) {
          // keep detailed error below
        }
      }
      throw Exception(
        'Unable to open paged playback session after retry: $e\nFiles were kept for inspection.\n${await getSessionDebugPath(video.id)}',
      );
    }
  }

  Future<void> _refreshLicenseOnly({
    required String token,
    required VideoItem video,
  }) async {
    final publicKeyPem = await keyService.getPublicKeyPem();
    final license = await apiService.requestLicense(
      token: token,
      videoId: video.id,
      publicKeyPem: publicKeyPem,
    );

    if (!license.isPaged) {
      throw Exception('Server did not return paged playback metadata.');
    }

    await _prepareAndCacheContentKey(video.id, license.encryptedDataKeyB64);

    final targetLicense = await _licenseFileFor(video.id);
    final licensePayload = {
      'videoId': license.videoId,
      'storageMode': license.storageMode,
      'encryptedDataKeyB64': license.encryptedDataKeyB64,
      'contentUrl': license.contentUrl,
      'requiresAuthForContent': license.requiresAuthForContent,
      'totalPlainSize': license.totalPlainSize,
      'pageSize': license.pageSize,
      'pageCount': license.pageCount,
    };
    await targetLicense.writeAsString(jsonEncode(licensePayload), flush: true);
  }

  Future<void> _prepareAndCacheContentKey(String videoId, String encryptedDataKeyB64) async {
    final cached = await cryptoService.loadCachedContentKey(videoId);
    if (cached != null) return;

    await keyService.cacheWrappedContentKey(videoId, encryptedDataKeyB64);
    final dataKey = await keyService.decryptDataKeyFromBase64(encryptedDataKeyB64);
    await cryptoService.cacheContentKey(videoId, dataKey);
  }

  Future<PreparedPlayback> preparePlayback({
    required String token,
    required VideoItem video,
  }) async {
    await downloadSession(token: token, video: video);
    return openDownloadedSession(video: video, token: token);
  }
}

class _PagedPlaybackProxy {
  _PagedPlaybackProxy({
    required this.videoId,
    required this.encryptedFile,
    required this.totalPlainSize,
    required this.pageSize,
    required this.pageCount,
    required this.dataKey,
    required this.cryptoService,
  }) : _keySignature = base64Encode(dataKey);

  final String videoId;
  final File encryptedFile;
  final int totalPlainSize;
  final int pageSize;
  final int pageCount;
  final Uint8List dataKey;
  final CryptoService cryptoService;
  final String _keySignature;

  HttpServer? _server;

  bool matches({
    required File encryptedFile,
    required int totalPlainSize,
    required int pageSize,
    required int pageCount,
    required Uint8List dataKey,
  }) {
    return this.encryptedFile.path == encryptedFile.path
        && this.totalPlainSize == totalPlainSize
        && this.pageSize == pageSize
        && this.pageCount == pageCount
        && _keySignature == base64Encode(dataKey);
  }

  Uri get playbackUri => Uri.parse('http://127.0.0.1:${_server!.port}/$videoId.mp4');

  Future<void> start() async {
    _server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    _server!.listen(_handleRequest);
  }

  Future<void> prewarm() async {
    if (totalPlainSize <= 0) return;
    final warmEnd = min(totalPlainSize - 1, max(pageSize - 1, 256 * 1024 - 1));
    await cryptoService.decryptPagedRange(
      encryptedFile: encryptedFile,
      dataKey: dataKey,
      start: 0,
      end: warmEnd,
    );
  }

  Future<void> close() async {
    await _server?.close(force: true);
    _server = null;
  }

  Future<void> _handleRequest(HttpRequest request) async {
    if (request.method != 'GET' && request.method != 'HEAD') {
      request.response.statusCode = HttpStatus.methodNotAllowed;
      await request.response.close();
      return;
    }

    final rangeHeader = request.headers.value(HttpHeaders.rangeHeader);
    var start = 0;
    var end = totalPlainSize - 1;
    var partial = false;

    if (rangeHeader != null && rangeHeader.startsWith('bytes=')) {
      final spec = rangeHeader.substring(6);
      final dashIndex = spec.indexOf('-');
      final startPart = dashIndex >= 0 ? spec.substring(0, dashIndex) : spec;
      final endPart = dashIndex >= 0 ? spec.substring(dashIndex + 1) : '';
      final parsedStart = int.tryParse(startPart);
      final parsedEnd = endPart.isNotEmpty ? int.tryParse(endPart) : null;
      if (parsedStart != null) {
        start = parsedStart.clamp(0, totalPlainSize - 1);
        end = (parsedEnd ?? end).clamp(start, totalPlainSize - 1);
        partial = true;
      }
    }

    final length = end - start + 1;
    final response = request.response;
    response.headers.set(HttpHeaders.acceptRangesHeader, 'bytes');
    response.headers.set(HttpHeaders.contentTypeHeader, 'video/mp4');
    response.headers.set(HttpHeaders.contentLengthHeader, length.toString());

    if (partial) {
      response.statusCode = HttpStatus.partialContent;
      response.headers.set(HttpHeaders.contentRangeHeader, 'bytes $start-$end/$totalPlainSize');
    } else {
      response.statusCode = HttpStatus.ok;
    }

    if (request.method == 'HEAD') {
      await response.close();
      return;
    }

    // Decrypt and send in smaller chunks to avoid OOM
    var currentStart = start;
    const chunkSize = 2 * 1024 * 1024; // 2MB

    while (currentStart <= end) {
      final currentEnd = min(currentStart + chunkSize - 1, end);
      final clearBytes = await cryptoService.decryptPagedRange(
        encryptedFile: encryptedFile,
        dataKey: dataKey,
        start: currentStart,
        end: currentEnd,
      );
      response.add(clearBytes);
      currentStart = currentEnd + 1;
    }
    await response.close();
  }
}
