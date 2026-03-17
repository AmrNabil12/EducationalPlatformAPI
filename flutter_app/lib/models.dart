class StudentSession {
  final String token;
  final String serial;
  final String deviceId;

  const StudentSession({
    required this.token,
    required this.serial,
    required this.deviceId,
  });

  factory StudentSession.fromJson(Map<String, dynamic> json) {
    final student = (json['student'] as Map<String, dynamic>? ?? {});
    return StudentSession(
      token: json['token'] as String? ?? '',
      serial: student['serial'] as String? ?? '',
      deviceId: student['deviceId'] as String? ?? '',
    );
  }
}

class VideoItem {
  final String id;
  final String title;
  final String month;
  final String session;
  final int? durationSec;

  const VideoItem({
    required this.id,
    required this.title,
    required this.month,
    required this.session,
    this.durationSec,
  });

  factory VideoItem.fromJson(Map<String, dynamic> json) {
    return VideoItem(
      id: json['id'] as String? ?? '',
      title: json['title'] as String? ?? '',
      month: json['month'] as String? ?? '',
      session: json['session'] as String? ?? 'S1',
      durationSec: json['durationSec'] as int?,
    );
  }
}

class PdfItem {
  final String id;
  final String title;
  final String month;
  final String session;
  final String downloadUrl;

  const PdfItem({
    required this.id,
    required this.title,
    required this.month,
    required this.session,
    required this.downloadUrl,
  });

  factory PdfItem.fromJson(Map<String, dynamic> json) {
    return PdfItem(
      id: json['id'] as String? ?? '',
      title: json['title'] as String? ?? '',
      month: json['month'] as String? ?? '',
      session: json['session'] as String? ?? 'S1',
      downloadUrl: json['downloadUrl'] as String? ?? '',
    );
  }
}

class SessionGroup {
  final String session;
  final List<VideoItem> videos;
  final List<PdfItem> pdfs;

  const SessionGroup({
    required this.session,
    required this.videos,
    required this.pdfs,
  });

  /// e.g. "S1" -> "Session 1"
  String get displayName {
    final match = RegExp(r'S(\d+)', caseSensitive: false).firstMatch(session);
    if (match != null) return 'Session ${match.group(1)}';
    return session;
  }
}

class MonthGroup {
  final String month;
  final List<VideoItem> videos;
  final List<PdfItem> pdfs;

  const MonthGroup({
    required this.month,
    required this.videos,
    required this.pdfs,
  });

  /// e.g. "M1" -> "Month 1"
  String get displayName {
    final match = RegExp(r'M(\d+)', caseSensitive: false).firstMatch(month);
    if (match != null) return 'Month ${match.group(1)}';
    return month;
  }

  List<SessionGroup> get sessions {
    final sessionKeys = <String>{};
    for (final v in videos) {
      sessionKeys.add(v.session.toUpperCase());
    }
    for (final p in pdfs) {
      sessionKeys.add(p.session.toUpperCase());
    }

    // Sort sessions: S1, S2, ... S5
    final sorted = sessionKeys.toList()
      ..sort((a, b) {
        final aNum = int.tryParse(a.replaceAll(RegExp(r'[^0-9]'), '')) ?? 0;
        final bNum = int.tryParse(b.replaceAll(RegExp(r'[^0-9]'), '')) ?? 0;
        return aNum.compareTo(bNum);
      });

    return sorted.map((s) {
      return SessionGroup(
        session: s,
        videos: videos.where((v) => v.session.toUpperCase() == s).toList(),
        pdfs: pdfs.where((p) => p.session.toUpperCase() == s).toList(),
      );
    }).toList();
  }

  factory MonthGroup.fromJson(Map<String, dynamic> json) {
    final videoList = (json['videos'] as List<dynamic>? ?? [])
        .map((v) => VideoItem.fromJson(v as Map<String, dynamic>))
        .toList();
    final pdfList = (json['pdfs'] as List<dynamic>? ?? [])
        .map((p) => PdfItem.fromJson(p as Map<String, dynamic>))
        .toList();
    return MonthGroup(
      month: json['month'] as String? ?? '',
      videos: videoList,
      pdfs: pdfList,
    );
  }
}

class EncryptedChunkInfo {
  final int index;
  final String fileName;
  final String url;
  final String nonceB64;
  final int plainSize;
  final int encryptedSize;

  const EncryptedChunkInfo({
    required this.index,
    required this.fileName,
    required this.url,
    required this.nonceB64,
    required this.plainSize,
    required this.encryptedSize,
  });

  factory EncryptedChunkInfo.fromJson(Map<String, dynamic> json) {
    return EncryptedChunkInfo(
      index: json['index'] as int? ?? 0,
      fileName: json['fileName'] as String? ?? '',
      url: json['url'] as String? ?? '',
      nonceB64: json['nonceB64'] as String? ?? '',
      plainSize: json['plainSize'] as int? ?? 0,
      encryptedSize: json['encryptedSize'] as int? ?? 0,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'index': index,
      'fileName': fileName,
      'url': url,
      'nonceB64': nonceB64,
      'plainSize': plainSize,
      'encryptedSize': encryptedSize,
    };
  }
}

class LicenseResponse {
  final String videoId;
  final String storageMode;
  final String videoNonceB64;
  final String encryptedDataKeyB64;
  final String plainDataKeyB64;
  final String contentUrl;
  final bool requiresAuthForContent;
  final int? totalPlainSize;
  final int? pageSize;
  final int? pageCount;
  final List<EncryptedChunkInfo> chunks;

  const LicenseResponse({
    required this.videoId,
    required this.storageMode,
    required this.videoNonceB64,
    required this.encryptedDataKeyB64,
    required this.plainDataKeyB64,
    required this.contentUrl,
    required this.requiresAuthForContent,
    required this.totalPlainSize,
    required this.pageSize,
    required this.pageCount,
    required this.chunks,
  });

  bool get isChunked => chunks.isNotEmpty;
  bool get isPaged => storageMode.toLowerCase() == 'paged';

  factory LicenseResponse.fromJson(Map<String, dynamic> json) {
    return LicenseResponse(
      videoId: json['videoId'] as String? ?? '',
      storageMode: json['storageMode'] as String? ?? '',
      videoNonceB64: json['videoNonceB64'] as String? ?? '',
      encryptedDataKeyB64: json['encryptedDataKeyB64'] as String? ?? '',
      plainDataKeyB64: json['plainDataKeyB64'] as String? ?? '',
      contentUrl: json['contentUrl'] as String? ?? '',
      requiresAuthForContent: json['requiresAuthForContent'] as bool? ?? false,
      totalPlainSize: json['totalPlainSize'] as int?,
      pageSize: json['pageSize'] as int?,
      pageCount: json['pageCount'] as int?,
      chunks: (json['chunks'] as List<dynamic>? ?? [])
          .map((c) => EncryptedChunkInfo.fromJson(c as Map<String, dynamic>))
          .toList(),
    );
  }
}