import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';
import 'package:http/http.dart' as http;

import '../models.dart';
import '../services/api_service.dart';
import '../services/auth_service.dart';
import '../services/playback_service.dart';
import 'video_player_screen.dart';
import 'package:flutter_pdfview/flutter_pdfview.dart';

// ---------------------------------------------------------------------------
// Month accent colours — one per month slot
// ---------------------------------------------------------------------------
const List<Color> _kMonthAccents = [
  Color(0xFF4F8EF7), // M1  – vivid blue
  Color(0xFF7C5CFC), // M2  – violet
  Color(0xFF00B894), // M3  – teal
  Color(0xFFFF7043), // M4  – deep orange
  Color(0xFFE91E8C), // M5  – pink
  Color(0xFF00ACC1), // M6  – cyan
  Color(0xFF8BC34A), // M7  – light green
  Color(0xFFFFB300), // M8  – amber
  Color(0xFFEF5350), // M9  – red
  Color(0xFF26A69A), // M10 – teal-green
  Color(0xFF7E57C2), // M11 – deep purple
  Color(0xFF42A5F5), // M12 – light blue
];

Color _accentFor(String month) {
  final n = int.tryParse(month.replaceAll(RegExp(r'[^0-9]'), '')) ?? 1;
  return _kMonthAccents[(n - 1).clamp(0, _kMonthAccents.length - 1)];
}

// ---------------------------------------------------------------------------

class MonthsScreen extends StatefulWidget {
  final ApiService apiService;
  final AuthService authService;
  final PlaybackService playbackService;
  final Future<void> Function() onLogout;

  const MonthsScreen({
    super.key,
    required this.apiService,
    required this.authService,
    required this.playbackService,
    required this.onLogout,
  });

  @override
  State<MonthsScreen> createState() => _MonthsScreenState();
}

class _MonthsScreenState extends State<MonthsScreen>
    with TickerProviderStateMixin {
  bool _loading = true;
  String? _error;
  String _displayName = '';
  List<MonthGroup> _months = const [];

  // Video download state
  final Map<String, bool> _downloadedByVideoId = {};
  final Set<String> _downloadingIds = {};
  final Set<String> _openingIds = {};
  final Map<String, double> _downloadProgressByVideoId = {};

  // PDF download state
  final Set<String> _pdfDownloadingIds = {};
  final Map<String, double> _pdfProgressByPdfId = {};
  final Map<String, String> _pdfLocalPathById = {}; // pdfId -> local file path

  // Animation controllers for list items
  late final AnimationController _listAnimController;

  void _safeSetState(VoidCallback fn) {
    if (!mounted) return;
    setState(fn);
  }

  @override
  void initState() {
    super.initState();
    _listAnimController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 600),
    );
    _load();
  }

  @override
  void dispose() {
    _listAnimController.dispose();
    super.dispose();
  }


  Future<void> _confirmLogout() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Sign Out'),
        content: const Text('Are you sure you want to sign out?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: Colors.red,
              foregroundColor: Colors.white,
            ),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Sign Out'),
          ),
        ],
      ),
    );
    if (confirmed == true) {
      await widget.onLogout();
    }
  }

  Future<void> _load() async {
    _safeSetState(() {
      _loading = true;
      _error = null;
    });

    try {
      final token = await widget.authService.getToken();
      final displayName = await widget.authService.getDisplayName();
      if (token == null || token.isEmpty) {
        throw Exception('Session expired. Please sign in again.');
      }

      final months = await widget.apiService.fetchMonths(token: token);
      _safeSetState(() {
        _months = months;
        _displayName = (displayName ?? '').trim();
      });

      await _refreshDownloadedStatuses();
      await _refreshPdfStatuses();
      _listAnimController
        ..reset()
        ..forward();
    } catch (e) {
      _safeSetState(() {
        _error = e.toString().replaceFirst('Exception: ', '');
      });
    } finally {
      _safeSetState(() => _loading = false);
    }
  }

  Future<void> _refreshDownloadedStatuses() async {
    final allVideos = _months.expand((m) => m.videos);
    final statuses = <String, bool>{};
    for (final video in allVideos) {
      statuses[video.id] =
          await widget.playbackService.hasDownloadedSession(video.id);
    }
    _safeSetState(() {
      _downloadedByVideoId
        ..clear()
        ..addAll(statuses);
    });
  }

  Future<void> _refreshPdfStatuses() async {
    final dir = await getApplicationSupportDirectory();
    final allPdfs = _months.expand((m) => m.pdfs);
    final paths = <String, String>{};
    for (final pdf in allPdfs) {
      final file = File('${dir.path}/pdfs/${pdf.id}.pdf');
      if (await file.exists()) {
        paths[pdf.id] = file.path;
      }
    }
    _safeSetState(() {
      _pdfLocalPathById
        ..clear()
        ..addAll(paths);
    });
  }

  // ── Video download / open ────────────────────────────────────────────────

  Future<void> _downloadVideo(VideoItem video) async {
    final token = await widget.authService.getToken();
    if (!mounted) return;

    if (token == null || token.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Session expired. Please sign in again.')),
      );
      await widget.onLogout();
      return;
    }

    final messenger = ScaffoldMessenger.of(context);
    _safeSetState(() {
      _downloadingIds.add(video.id);
      _downloadProgressByVideoId[video.id] = 0;
    });

    try {
      await widget.playbackService.downloadSession(
        token: token,
        video: video,
        onProgress: (p) {
          _safeSetState(() => _downloadProgressByVideoId[video.id] = p);
        },
      );
      if (!mounted) return;
      _safeSetState(() {
        _downloadedByVideoId[video.id] = true;
        _downloadProgressByVideoId[video.id] = 1;
      });
      messenger.showSnackBar(
        SnackBar(content: Text('${video.title} downloaded.')),
      );
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(content: Text(e.toString().replaceFirst('Exception: ', ''))),
      );
    } finally {
      _safeSetState(() => _downloadingIds.remove(video.id));
    }
  }

  Future<void> _openVideo(VideoItem video) async {
    if (!(_downloadedByVideoId[video.id] ?? false)) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please download this session first.')),
      );
      return;
    }

    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final token = await widget.authService.getToken();
    if (!mounted) return;
    if (token == null || token.isEmpty) {
      messenger.showSnackBar(
        const SnackBar(content: Text('Session expired. Please sign in again.')),
      );
      await widget.onLogout();
      return;
    }

    _safeSetState(() => _openingIds.add(video.id));

    showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (_) => const Center(child: CircularProgressIndicator()),
    );

    try {
      final prepared = await widget.playbackService.openDownloadedSession(
        video: video,
        token: token,
      );
      if (!mounted) return;
      if (navigator.canPop()) navigator.pop();
      await navigator.push(
        MaterialPageRoute(
          builder: (_) => VideoPlayerScreen(
            video: video,
            file: prepared.file,
            networkUri: prepared.networkUri,
            httpHeaders: prepared.httpHeaders,
          ),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      if (navigator.canPop()) navigator.pop();
      final message = e.toString().replaceFirst('Exception: ', '');
      if (message.contains('Storage folder:')) {
        await showDialog<void>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: const Text('Playback failed'),
            content:
                SingleChildScrollView(child: SelectableText(message)),
            actions: [
              TextButton(
                onPressed: () async {
                  await Clipboard.setData(ClipboardData(text: message));
                  if (!ctx.mounted) return;
                  Navigator.of(ctx).pop();
                  messenger.showSnackBar(const SnackBar(
                      content: Text('Error details copied.')));
                },
                child: const Text('Copy details'),
              ),
              TextButton(
                onPressed: () => Navigator.of(ctx).pop(),
                child: const Text('OK'),
              ),
            ],
          ),
        );
      } else {
        messenger.showSnackBar(SnackBar(
          content: Text(message),
          duration: const Duration(seconds: 12),
        ));
      }
    } finally {
      _safeSetState(() => _openingIds.remove(video.id));
    }
  }

  // ── PDF download / open ──────────────────────────────────────────────────

  Future<void> _downloadPdf(PdfItem pdf) async {
    final token = await widget.authService.getToken();
    if (!mounted) return;
    if (token == null || token.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Session expired. Please sign in again.')),
      );
      await widget.onLogout();
      return;
    }

    final messenger = ScaffoldMessenger.of(context);
    _safeSetState(() {
      _pdfDownloadingIds.add(pdf.id);
      _pdfProgressByPdfId[pdf.id] = 0;
    });

    try {
      final dir = await getApplicationSupportDirectory();
      final pdfDir = Directory('${dir.path}/pdfs');
      await pdfDir.create(recursive: true);
      final outFile = File('${pdfDir.path}/${pdf.id}.pdf');

      // Resolve the URL — if it's a relative path use the api base
      final resolvedUrl = pdf.downloadUrl.startsWith('/')
          ? '${ApiService.baseUrl}${pdf.downloadUrl}'
          : pdf.downloadUrl;

      final client = http.Client();
      try {
        final request = http.Request('GET', Uri.parse(resolvedUrl));
        request.headers['Authorization'] = 'Bearer $token';
        final response = await client.send(request);

        if (response.statusCode >= 400) {
          throw Exception('Failed to download PDF (${response.statusCode})');
        }

        final total = response.contentLength ?? -1;
        var received = 0;
        final sink = outFile.openWrite();
        await for (final chunk in response.stream) {
          sink.add(chunk);
          received += chunk.length;
          if (total > 0) {
            _safeSetState(() =>
                _pdfProgressByPdfId[pdf.id] =
                    (received / total).clamp(0.0, 1.0));
          }
        }
        await sink.flush();
        await sink.close();
      } finally {
        client.close();
      }

      _safeSetState(() {
        _pdfLocalPathById[pdf.id] = outFile.path;
        _pdfProgressByPdfId[pdf.id] = 1;
      });
      messenger.showSnackBar(
          SnackBar(content: Text('${pdf.title} downloaded.')));
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(content: Text(e.toString().replaceFirst('Exception: ', ''))),
      );
    } finally {
      _safeSetState(() => _pdfDownloadingIds.remove(pdf.id));
    }
  }

  Future<void> _openPdf(PdfItem pdf) async {
    final localPath = _pdfLocalPathById[pdf.id];
    if (localPath == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please download the PDF first.')),
      );
      return;
    }
    // Open the PDF viewer screen
    if (!mounted) return;
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => _PdfViewerScreen(
          title: pdf.title,
          filePath: localPath,
        ),
      ),
    );
  }

  // ── Build ────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return Scaffold(
      backgroundColor: const Color(0xFFF0F4FF),
      appBar: AppBar(
        backgroundColor: colorScheme.primary,
        foregroundColor: Colors.white,
        elevation: 0,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Course Content',
              style: TextStyle(
                fontWeight: FontWeight.w800,
                fontSize: 20,
                color: Colors.white,
              ),
            ),
            if (_displayName.isNotEmpty)
              Text(
                'Welcome, $_displayName',
                style: const TextStyle(
                  fontSize: 12,
                  color: Colors.white70,
                  fontWeight: FontWeight.w400,
                ),
              ),
          ],
        ),
        actions: [
          IconButton(
            onPressed: _confirmLogout,
            icon: const Icon(Icons.logout, color: Colors.white),
            tooltip: 'Logout',
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? _buildError()
              : RefreshIndicator(
                  onRefresh: _load,
                  child: _buildList(),
                ),
    );
  }

  Widget _buildError() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.cloud_off_rounded, size: 52, color: Colors.grey),
            const SizedBox(height: 16),
            Text(_error!, textAlign: TextAlign.center),
            const SizedBox(height: 16),
            ElevatedButton.icon(
              onPressed: _load,
              icon: const Icon(Icons.refresh),
              label: const Text('Retry'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildList() {
    final visible = _months.where((m) => m.sessions.isNotEmpty).toList();
    if (visible.isEmpty) {
      return const Center(
        child: Text('No content available yet.',
            style: TextStyle(color: Colors.grey)),
      );
    }

    return ListView.builder(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
      physics: const AlwaysScrollableScrollPhysics(),
      itemCount: visible.length,
      itemBuilder: (context, index) {
        final delay = index * 80;
        return AnimatedBuilder(
          animation: _listAnimController,
          builder: (context, child) {
            final start = (delay / 600).clamp(0.0, 1.0);
            final end = ((delay + 350) / 600).clamp(0.0, 1.0);
            final t = Curves.easeOutCubic.transform(
              ((_listAnimController.value - start) / (end - start))
                  .clamp(0.0, 1.0),
            );
            return Opacity(
              opacity: t,
              child: Transform.translate(
                offset: Offset(0, 28 * (1 - t)),
                child: child,
              ),
            );
          },
          child: _MonthCard(
            monthGroup: visible[index],
            downloadedByVideoId: _downloadedByVideoId,
            downloadingIds: _downloadingIds,
            openingIds: _openingIds,
            downloadProgressByVideoId: _downloadProgressByVideoId,
            pdfDownloadingIds: _pdfDownloadingIds,
            pdfProgressByPdfId: _pdfProgressByPdfId,
            pdfLocalPathById: _pdfLocalPathById,
            onDownloadVideo: _downloadVideo,
            onOpenVideo: _openVideo,
            onDownloadPdf: _downloadPdf,
            onOpenPdf: _openPdf,
          ),
        );
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Month card
// ---------------------------------------------------------------------------
class _MonthCard extends StatefulWidget {
  final MonthGroup monthGroup;
  final Map<String, bool> downloadedByVideoId;
  final Set<String> downloadingIds;
  final Set<String> openingIds;
  final Map<String, double> downloadProgressByVideoId;
  final Set<String> pdfDownloadingIds;
  final Map<String, double> pdfProgressByPdfId;
  final Map<String, String> pdfLocalPathById;
  final void Function(VideoItem) onDownloadVideo;
  final void Function(VideoItem) onOpenVideo;
  final void Function(PdfItem) onDownloadPdf;
  final void Function(PdfItem) onOpenPdf;

  const _MonthCard({
    required this.monthGroup,
    required this.downloadedByVideoId,
    required this.downloadingIds,
    required this.openingIds,
    required this.downloadProgressByVideoId,
    required this.pdfDownloadingIds,
    required this.pdfProgressByPdfId,
    required this.pdfLocalPathById,
    required this.onDownloadVideo,
    required this.onOpenVideo,
    required this.onDownloadPdf,
    required this.onOpenPdf,
  });

  @override
  State<_MonthCard> createState() => _MonthCardState();
}

class _MonthCardState extends State<_MonthCard>
    with SingleTickerProviderStateMixin {
  bool _expanded = false;
  late final AnimationController _expandCtrl;
  late final Animation<double> _expandAnim;

  @override
  void initState() {
    super.initState();
    _expandCtrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 320),
    );
    _expandAnim = CurvedAnimation(
      parent: _expandCtrl,
      curve: Curves.easeInOutCubic,
    );
  }

  @override
  void dispose() {
    _expandCtrl.dispose();
    super.dispose();
  }

  void _toggle() {
    setState(() => _expanded = !_expanded);
    if (_expanded) {
      _expandCtrl.forward();
    } else {
      _expandCtrl.reverse();
    }
  }

  @override
  Widget build(BuildContext context) {
    final accent = _accentFor(widget.monthGroup.month);
    final sessions = widget.monthGroup.sessions;
    final totalVideos = widget.monthGroup.videos.length;
    final totalPdfs = widget.monthGroup.pdfs.length;

    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Container(
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(20),
          boxShadow: [
            BoxShadow(
              color: accent.withValues(alpha: 0.18),
              blurRadius: 16,
              offset: const Offset(0, 6),
            ),
          ],
        ),
        child: Column(
          children: [
            // ── Header ──────────────────────────────────────────────────
            InkWell(
              onTap: _toggle,
              borderRadius: BorderRadius.circular(20),
              child: Container(
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    colors: [
                      accent,
                      accent.withValues(alpha: 0.75),
                    ],
                    begin: Alignment.centerLeft,
                    end: Alignment.centerRight,
                  ),
                  borderRadius: _expanded
                      ? const BorderRadius.vertical(top: Radius.circular(20))
                      : BorderRadius.circular(20),
                ),
                padding: const EdgeInsets.symmetric(
                    horizontal: 18, vertical: 16),
                child: Row(
                  children: [
                    // Month number badge
                    Container(
                      width: 46,
                      height: 46,
                      decoration: BoxDecoration(
                        color: Colors.white.withValues(alpha: 0.25),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      alignment: Alignment.center,
                      child: Text(
                        widget.monthGroup.month
                            .replaceAll(RegExp(r'[^0-9]'), ''),
                        style: const TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.w900,
                          fontSize: 20,
                        ),
                      ),
                    ),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            widget.monthGroup.displayName,
                            style: const TextStyle(
                              color: Colors.white,
                              fontWeight: FontWeight.w800,
                              fontSize: 17,
                            ),
                          ),
                          const SizedBox(height: 3),
                          Text(
                            '$totalVideos video${totalVideos != 1 ? 's' : ''}  •  $totalPdfs PDF${totalPdfs != 1 ? 's' : ''}',
                            style: const TextStyle(
                              color: Colors.white70,
                              fontSize: 12,
                            ),
                          ),
                        ],
                      ),
                    ),
                    AnimatedRotation(
                      turns: _expanded ? 0.5 : 0,
                      duration: const Duration(milliseconds: 320),
                      child: const Icon(
                        Icons.keyboard_arrow_down_rounded,
                        color: Colors.white,
                        size: 28,
                      ),
                    ),
                  ],
                ),
              ),
            ),

            // ── Sessions ─────────────────────────────────────────────────
            SizeTransition(
              sizeFactor: _expandAnim,
              child: Column(
                children: [
                  ...sessions.map((session) => _SessionTile(
                        session: session,
                        accent: accent,
                        downloadedByVideoId: widget.downloadedByVideoId,
                        downloadingIds: widget.downloadingIds,
                        openingIds: widget.openingIds,
                        downloadProgressByVideoId:
                            widget.downloadProgressByVideoId,
                        pdfDownloadingIds: widget.pdfDownloadingIds,
                        pdfProgressByPdfId: widget.pdfProgressByPdfId,
                        pdfLocalPathById: widget.pdfLocalPathById,
                        onDownloadVideo: widget.onDownloadVideo,
                        onOpenVideo: widget.onOpenVideo,
                        onDownloadPdf: widget.onDownloadPdf,
                        onOpenPdf: widget.onOpenPdf,
                      )),
                  const SizedBox(height: 8),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Session tile
// ---------------------------------------------------------------------------
class _SessionTile extends StatefulWidget {
  final SessionGroup session;
  final Color accent;
  final Map<String, bool> downloadedByVideoId;
  final Set<String> downloadingIds;
  final Set<String> openingIds;
  final Map<String, double> downloadProgressByVideoId;
  final Set<String> pdfDownloadingIds;
  final Map<String, double> pdfProgressByPdfId;
  final Map<String, String> pdfLocalPathById;
  final void Function(VideoItem) onDownloadVideo;
  final void Function(VideoItem) onOpenVideo;
  final void Function(PdfItem) onDownloadPdf;
  final void Function(PdfItem) onOpenPdf;

  const _SessionTile({
    required this.session,
    required this.accent,
    required this.downloadedByVideoId,
    required this.downloadingIds,
    required this.openingIds,
    required this.downloadProgressByVideoId,
    required this.pdfDownloadingIds,
    required this.pdfProgressByPdfId,
    required this.pdfLocalPathById,
    required this.onDownloadVideo,
    required this.onOpenVideo,
    required this.onDownloadPdf,
    required this.onOpenPdf,
  });

  @override
  State<_SessionTile> createState() => _SessionTileState();
}

class _SessionTileState extends State<_SessionTile>
    with SingleTickerProviderStateMixin {
  bool _expanded = true; // sessions open by default
  late final AnimationController _ctrl;
  late final Animation<double> _anim;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 260),
      value: 1, // start expanded
    );
    _anim = CurvedAnimation(parent: _ctrl, curve: Curves.easeInOutCubic);
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  void _toggle() {
    setState(() => _expanded = !_expanded);
    _expanded ? _ctrl.forward() : _ctrl.reverse();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
      child: Container(
        decoration: BoxDecoration(
          color: widget.accent.withValues(alpha: 0.06),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
            color: widget.accent.withValues(alpha: 0.18),
          ),
        ),
        child: Column(
          children: [
            // Session header
            InkWell(
              onTap: _toggle,
              borderRadius: BorderRadius.circular(14),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                    horizontal: 14, vertical: 10),
                child: Row(
                  children: [
                    Icon(Icons.folder_open_rounded,
                        color: widget.accent, size: 20),
                    const SizedBox(width: 10),
                    Text(
                      widget.session.displayName,
                      style: TextStyle(
                        color: widget.accent,
                        fontWeight: FontWeight.w700,
                        fontSize: 14,
                      ),
                    ),
                    const Spacer(),
                    AnimatedRotation(
                      turns: _expanded ? 0.5 : 0,
                      duration: const Duration(milliseconds: 260),
                      child: Icon(Icons.expand_more,
                          color: widget.accent, size: 20),
                    ),
                  ],
                ),
              ),
            ),
            SizeTransition(
              sizeFactor: _anim,
              child: Column(
                children: [
                  const Divider(height: 1, indent: 14, endIndent: 14),
                  const SizedBox(height: 4),
                  // Videos
                  ...widget.session.videos.map((video) => _VideoRow(
                        video: video,
                        accent: widget.accent,
                        isDownloaded:
                            widget.downloadedByVideoId[video.id] ?? false,
                        isDownloading:
                            widget.downloadingIds.contains(video.id),
                        isOpening: widget.openingIds.contains(video.id),
                        progress: widget
                                .downloadProgressByVideoId[video.id] ??
                            0,
                        onDownload: () => widget.onDownloadVideo(video),
                        onOpen: () => widget.onOpenVideo(video),
                      )),
                  // PDFs
                  ...widget.session.pdfs.map((pdf) => _PdfRow(
                        pdf: pdf,
                        accent: widget.accent,
                        isDownloaded:
                            widget.pdfLocalPathById.containsKey(pdf.id),
                        isDownloading:
                            widget.pdfDownloadingIds.contains(pdf.id),
                        progress:
                            widget.pdfProgressByPdfId[pdf.id] ?? 0,
                        onDownload: () => widget.onDownloadPdf(pdf),
                        onOpen: () => widget.onOpenPdf(pdf),
                      )),
                  const SizedBox(height: 6),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Video row
// ---------------------------------------------------------------------------
class _VideoRow extends StatelessWidget {
  final VideoItem video;
  final Color accent;
  final bool isDownloaded;
  final bool isDownloading;
  final bool isOpening;
  final double progress;
  final VoidCallback onDownload;
  final VoidCallback onOpen;

  const _VideoRow({
    required this.video,
    required this.accent,
    required this.isDownloaded,
    required this.isDownloading,
    required this.isOpening,
    required this.progress,
    required this.onDownload,
    required this.onOpen,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      child: Container(
        decoration: BoxDecoration(
          color: isDownloaded
              ? Colors.green.withValues(alpha: 0.07)
              : Colors.white,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: isDownloaded
                ? Colors.green.withValues(alpha: 0.3)
                : Colors.grey.withValues(alpha: 0.15),
          ),
        ),
        child: Column(
          children: [
            ListTile(
              dense: true,
              leading: Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                  color: accent.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Icon(Icons.videocam_rounded,
                    color: accent, size: 20),
              ),
              title: Text(
                video.title,
                style: const TextStyle(
                    fontSize: 13, fontWeight: FontWeight.w600),
              ),
              subtitle: Text(
                isDownloaded ? 'Ready to play' : 'Not downloaded',
                style: TextStyle(
                  fontSize: 11,
                  color: isDownloaded ? Colors.green : Colors.grey,
                ),
              ),
              trailing: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  _IconBtn(
                    tooltip: isDownloaded ? 'Re-download' : 'Download',
                    onTap: isDownloading ? null : onDownload,
                    child: isDownloading
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(
                                strokeWidth: 2),
                          )
                        : Icon(
                            Icons.download_rounded,
                            size: 20,
                            color: isDownloaded
                                ? Colors.green.shade700
                                : accent,
                          ),
                  ),
                  _IconBtn(
                    tooltip: 'Play',
                    onTap: isOpening ? null : onOpen,
                    child: isOpening
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(
                                strokeWidth: 2),
                          )
                        : Icon(Icons.play_circle_fill_rounded,
                            size: 22, color: accent),
                  ),
                ],
              ),
            ),
            if (isDownloading)
              Padding(
                padding:
                    const EdgeInsets.fromLTRB(14, 0, 14, 8),
                child: TweenAnimationBuilder<double>(
                  tween: Tween(begin: 0, end: progress),
                  duration: const Duration(milliseconds: 180),
                  builder: (_, v, __) => Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      LinearProgressIndicator(
                        value: v <= 0 ? null : v,
                        minHeight: 5,
                        borderRadius: BorderRadius.circular(8),
                        color: accent,
                      ),
                      const SizedBox(height: 3),
                      Text(
                        v <= 0
                            ? 'Downloading...'
                            : 'Downloading ${(v * 100).toStringAsFixed(0)}%',
                        style: const TextStyle(fontSize: 10),
                      ),
                    ],
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// PDF row
// ---------------------------------------------------------------------------
class _PdfRow extends StatelessWidget {
  final PdfItem pdf;
  final Color accent;
  final bool isDownloaded;
  final bool isDownloading;
  final double progress;
  final VoidCallback onDownload;
  final VoidCallback onOpen;

  const _PdfRow({
    required this.pdf,
    required this.accent,
    required this.isDownloaded,
    required this.isDownloading,
    required this.progress,
    required this.onDownload,
    required this.onOpen,
  });

  @override
  Widget build(BuildContext context) {
    const pdfRed = Color(0xFFE53935);

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      child: Container(
        decoration: BoxDecoration(
          color: isDownloaded
              ? pdfRed.withValues(alpha: 0.05)
              : Colors.white,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: isDownloaded
                ? pdfRed.withValues(alpha: 0.25)
                : Colors.grey.withValues(alpha: 0.15),
          ),
        ),
        child: Column(
          children: [
            ListTile(
              dense: true,
              leading: Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                  color: pdfRed.withValues(alpha: 0.1),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: const Icon(Icons.picture_as_pdf_rounded,
                    color: pdfRed, size: 20),
              ),
              title: Text(
                pdf.title,
                style: const TextStyle(
                    fontSize: 13, fontWeight: FontWeight.w600),
              ),
              subtitle: Text(
                isDownloaded ? 'Ready to open' : 'Not downloaded',
                style: TextStyle(
                  fontSize: 11,
                  color: isDownloaded ? pdfRed : Colors.grey,
                ),
              ),
              trailing: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  _IconBtn(
                    tooltip: isDownloaded ? 'Re-download PDF' : 'Download PDF',
                    onTap: isDownloading ? null : onDownload,
                    child: isDownloading
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(
                                strokeWidth: 2),
                          )
                        : Icon(
                            Icons.download_rounded,
                            size: 20,
                            color: isDownloaded
                                ? pdfRed
                                : accent,
                          ),
                  ),
                  _IconBtn(
                    tooltip: 'Open PDF',
                    onTap: isDownloaded ? onOpen : null,
                    child: Icon(
                      Icons.open_in_new_rounded,
                      size: 20,
                      color: isDownloaded ? pdfRed : Colors.grey,
                    ),
                  ),
                ],
              ),
            ),
            if (isDownloading)
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 0, 14, 8),
                child: TweenAnimationBuilder<double>(
                  tween: Tween(begin: 0, end: progress),
                  duration: const Duration(milliseconds: 180),
                  builder: (_, v, __) => Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      LinearProgressIndicator(
                        value: v <= 0 ? null : v,
                        minHeight: 5,
                        borderRadius: BorderRadius.circular(8),
                        color: pdfRed,
                      ),
                      const SizedBox(height: 3),
                      Text(
                        v <= 0
                            ? 'Downloading PDF...'
                            : 'Downloading ${(v * 100).toStringAsFixed(0)}%',
                        style: const TextStyle(fontSize: 10),
                      ),
                    ],
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Tiny icon button helper
// ---------------------------------------------------------------------------
class _IconBtn extends StatelessWidget {
  final Widget child;
  final VoidCallback? onTap;
  final String tooltip;

  const _IconBtn({
    required this.child,
    required this.tooltip,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tooltip,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(20),
        child: Padding(
          padding: const EdgeInsets.all(6),
          child: child,
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Simple PDF viewer screen (uses flutter_pdfview or similar)
// For now shows a "open with" message — replace with your PDF viewer package
// ---------------------------------------------------------------------------
class _PdfViewerScreen extends StatefulWidget {
  final String title;
  final String filePath;

  const _PdfViewerScreen({
    required this.title,
    required this.filePath,
  });

  @override
  State<_PdfViewerScreen> createState() => _PdfViewerScreenState();
}

class _PdfViewerScreenState extends State<_PdfViewerScreen> {
  int _totalPages = 0;
  int _currentPage = 0;
  bool _isFullscreen = false;

  @override
  void initState() {
    super.initState();
    SystemChrome.setPreferredOrientations([
      DeviceOrientation.portraitUp,
      DeviceOrientation.landscapeLeft,
      DeviceOrientation.landscapeRight,
    ]);
  }

  @override
  void dispose() {
    SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
    super.dispose();
  }

  Future<void> _toggleFullscreen() async {
    if (_isFullscreen) {
      await SystemChrome.setPreferredOrientations([
        DeviceOrientation.portraitUp,
        DeviceOrientation.landscapeLeft,
        DeviceOrientation.landscapeRight,
      ]);
      await SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
    } else {
      await SystemChrome.setPreferredOrientations([
        DeviceOrientation.landscapeLeft,
        DeviceOrientation.landscapeRight,
      ]);
      await SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
    }
    if (!mounted) return;
    setState(() => _isFullscreen = !_isFullscreen);
  }

  @override
  Widget build(BuildContext context) {
    final isLandscape =
        MediaQuery.of(context).orientation == Orientation.landscape;

    return Scaffold(
      appBar: isLandscape
          ? null
          : AppBar(
              title: Text(widget.title),
              actions: [
                if (_totalPages > 0)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    child: Center(
                      child: Text(
                        '${_currentPage + 1} / $_totalPages',
                        style: const TextStyle(fontSize: 14),
                      ),
                    ),
                  ),
              ],
            ),
      body: Stack(
        children: [
          PDFView(
            filePath: widget.filePath,
            enableSwipe: true,
            swipeHorizontal: false,
            autoSpacing: true,
            pageFling: true,
            onRender: (pages) {
              setState(() => _totalPages = pages ?? 0);
            },
            onPageChanged: (page, total) {
              setState(() => _currentPage = page ?? 0);
            },
          ),
          // Fullscreen toggle button — bottom right
          Positioned(
            bottom: 16,
            right: 16,
            child: Material(
              color: Colors.black54,
              borderRadius: BorderRadius.circular(8),
              child: InkWell(
                borderRadius: BorderRadius.circular(8),
                onTap: _toggleFullscreen,
                child: Padding(
                  padding: const EdgeInsets.all(8),
                  child: Icon(
                    _isFullscreen ? Icons.fullscreen_exit : Icons.fullscreen,
                    color: Colors.white,
                    size: 24,
                  ),
                ),
              ),
            ),
          ),
          // Page indicator in landscape
          if (isLandscape && _totalPages > 0)
            Positioned(
              bottom: 16,
              left: 16,
              child: Material(
                color: Colors.black54,
                borderRadius: BorderRadius.circular(8),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                      horizontal: 12, vertical: 6),
                  child: Text(
                    '${_currentPage + 1} / $_totalPages',
                    style: const TextStyle(
                        color: Colors.white, fontSize: 13),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}