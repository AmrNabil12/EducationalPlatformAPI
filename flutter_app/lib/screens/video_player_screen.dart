import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:video_player/video_player.dart';

import '../models.dart';

class VideoPlayerScreen extends StatefulWidget {
  final VideoItem video;
  final File? file;
  final Uri? networkUri;
  final Map<String, String>? httpHeaders;

  const VideoPlayerScreen({
    super.key,
    required this.video,
    this.file,
    this.networkUri,
    this.httpHeaders,
  });

  @override
  State<VideoPlayerScreen> createState() => _VideoPlayerScreenState();
}

class _VideoPlayerScreenState extends State<VideoPlayerScreen> {
  late final VideoPlayerController _controller;
  bool _controllerReady = false;
  bool _initializing = true;
  String? _initError;
  double _playbackSpeed = 1.0;
  double _volume = 1.0;
  bool _isFullscreen = false;

  @override
  void initState() {
    super.initState();
    // Allow both portrait and landscape from the start
    SystemChrome.setPreferredOrientations([
      DeviceOrientation.portraitUp,
      DeviceOrientation.landscapeLeft,
      DeviceOrientation.landscapeRight,
    ]);

    try {
      if (widget.networkUri != null) {
        _controller = VideoPlayerController.networkUrl(
          widget.networkUri!,
          httpHeaders: widget.httpHeaders ?? const {},
        );
      } else if (widget.file != null) {
        _controller = VideoPlayerController.file(widget.file!);
      } else {
        throw StateError('No video source provided.');
      }

      _controllerReady = true;
      _init();
    } catch (e) {
      _initializing = false;
      _initError = e.toString().replaceFirst('Exception: ', '');
    }
  }

  Future<void> _init() async {
    try {
      await _controller.initialize();
      await _controller.setLooping(false);
      await _controller.setVolume(_volume);
      await _controller.setPlaybackSpeed(_playbackSpeed);
      if (!mounted) return;
      setState(() {
        _initializing = false;
        _initError = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _initializing = false;
        _initError = e.toString().replaceFirst('Exception: ', '');
      });
    }
  }

  @override
  void dispose() {
    // Restore portrait-only when leaving this screen
    SystemChrome.setPreferredOrientations([
      DeviceOrientation.portraitUp,
    ]);
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
    if (_controllerReady) {
      _controller.dispose();
    }
    super.dispose();
  }

  Future<void> _seekRelative(Duration offset) async {
    final current = _controller.value.position;
    final target = current + offset;
    final total = _controller.value.duration;
    if (target < Duration.zero) {
      await _controller.seekTo(Duration.zero);
      return;
    }
    if (target > total) {
      await _controller.seekTo(total);
      return;
    }
    await _controller.seekTo(target);
  }

  Future<void> _setSpeed(double speed) async {
    await _controller.setPlaybackSpeed(speed);
    if (mounted) {
      setState(() {
        _playbackSpeed = speed;
      });
    }
  }

  Future<void> _increaseVolume() async {
    final next = (_volume + 0.1).clamp(0.0, 1.0);
    if ((next - _volume).abs() < 0.0001) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'Volume is at app maximum. Use device volume buttons for more loudness.',
          ),
        ),
      );
      return;
    }

    await _controller.setVolume(next);
    if (!mounted) return;
    setState(() {
      _volume = next;
    });
  }

  Future<void> _toggleFullscreen() async {
    if (_isFullscreen) {
      // Exit fullscreen: back to portrait, restore UI
      await SystemChrome.setPreferredOrientations([
        DeviceOrientation.portraitUp,
        DeviceOrientation.landscapeLeft,
        DeviceOrientation.landscapeRight,
      ]);
      await SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
    } else {
      // Enter fullscreen: force landscape, hide system UI
      await SystemChrome.setPreferredOrientations([
        DeviceOrientation.landscapeLeft,
        DeviceOrientation.landscapeRight,
      ]);
      await SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
    }

    if (!mounted) return;
    setState(() {
      _isFullscreen = !_isFullscreen;
    });
  }

  Future<void> _openSettings() async {
    final speedOptions = [0.75, 1.0, 1.25, 1.5, 2.0];
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (context) {
        return SafeArea(
          child: Padding(
            padding: EdgeInsets.only(
              bottom: MediaQuery.of(context).viewInsets.bottom,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const ListTile(title: Text('Playback settings')),
                ...speedOptions.map(
                  (speed) => ListTile(
                    leading: const Icon(Icons.speed),
                    title: Text('${speed}x'),
                    trailing: (_playbackSpeed - speed).abs() < 0.0001
                        ? const Icon(Icons.check)
                        : null,
                    onTap: () async {
                      Navigator.of(context).pop();
                      await _setSpeed(speed);
                    },
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  /// Builds the video + controls block, used in both portrait and landscape.
  Widget _buildVideoWithControls(BuildContext context, {bool compact = false}) {
    final videoWidget = AspectRatio(
      aspectRatio: _controller.value.aspectRatio > 0
          ? _controller.value.aspectRatio
          : 16 / 9,
      child: Stack(
        alignment: Alignment.bottomRight,
        children: [
          VideoPlayer(_controller),
          // Fullscreen toggle button — bottom-right corner of the video
          Padding(
            padding: const EdgeInsets.all(8),
            child: Material(
              color: Colors.black45,
              borderRadius: BorderRadius.circular(6),
              child: InkWell(
                borderRadius: BorderRadius.circular(6),
                onTap: _toggleFullscreen,
                child: Padding(
                  padding: const EdgeInsets.all(6),
                  child: Icon(
                    _isFullscreen ? Icons.fullscreen_exit : Icons.fullscreen,
                    color: Colors.white,
                    size: 22,
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );

    final controls = Padding(
      padding: EdgeInsets.symmetric(
        horizontal: compact ? 8 : 12,
        vertical: compact ? 4 : 8,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          VideoProgressIndicator(
            _controller,
            allowScrubbing: true,
            padding: EdgeInsets.symmetric(vertical: compact ? 4 : 8),
          ),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              IconButton(
                onPressed: () => _seekRelative(const Duration(seconds: -10)),
                icon: const Icon(Icons.replay_10),
              ),
              IconButton(
                onPressed: () {
                  if (_controller.value.isPlaying) {
                    _controller.pause();
                  } else {
                    _controller.play();
                  }
                  setState(() {});
                },
                icon: Icon(
                  _controller.value.isPlaying
                      ? Icons.pause_circle
                      : Icons.play_circle,
                ),
              ),
              IconButton(
                onPressed: () => _seekRelative(const Duration(seconds: 10)),
                icon: const Icon(Icons.forward_10),
              ),
              IconButton(
                onPressed: _increaseVolume,
                icon: const Icon(Icons.volume_up),
                tooltip: 'Increase volume',
              ),
              IconButton(
                onPressed: _openSettings,
                icon: const Icon(Icons.settings),
                tooltip: 'Playback settings',
              ),
            ],
          ),
          if (!compact) ...[
            const SizedBox(height: 4),
            Text(
              'Speed: ${_playbackSpeed}x   •   Volume: ${_volume.toStringAsFixed(2)}x',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ],
      ),
    );

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [videoWidget, controls],
    );
  }

  @override
  Widget build(BuildContext context) {
    final isLandscape =
        MediaQuery.of(context).orientation == Orientation.landscape;

    if (_initializing) {
      return Scaffold(
        appBar: isLandscape ? null : AppBar(title: Text(widget.video.title)),
        body: const Center(child: CircularProgressIndicator()),
      );
    }

    if (_initError != null) {
      return Scaffold(
        appBar: isLandscape ? null : AppBar(title: Text(widget.video.title)),
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Text(
                  'Failed to load video source.',
                  style: TextStyle(fontWeight: FontWeight.w600),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 8),
                Text(_initError!, textAlign: TextAlign.center),
              ],
            ),
          ),
        ),
      );
    }

    // ── Landscape / fullscreen layout ──────────────────────────────────────
    if (isLandscape) {
      return Scaffold(
        backgroundColor: Colors.black,
        body: SafeArea(
          child: Column(
            children: [
              Expanded(
                child: Stack(
                  alignment: Alignment.bottomRight,
                  children: [
                    Center(
                      child: AspectRatio(
                        aspectRatio: _controller.value.aspectRatio > 0
                            ? _controller.value.aspectRatio
                            : 16 / 9,
                        child: VideoPlayer(_controller),
                      ),
                    ),
                    // Fullscreen exit button
                    Padding(
                      padding: const EdgeInsets.all(8),
                      child: Material(
                        color: Colors.black45,
                        borderRadius: BorderRadius.circular(6),
                        child: InkWell(
                          borderRadius: BorderRadius.circular(6),
                          onTap: _toggleFullscreen,
                          child: Padding(
                            padding: const EdgeInsets.all(6),
                            child: Icon(
                              _isFullscreen
                                  ? Icons.fullscreen_exit
                                  : Icons.fullscreen,
                              color: Colors.white,
                              size: 22,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              // Compact controls bar at the bottom
              ColoredBox(
                color: Colors.black,
                child: _buildLandscapeControls(context),
              ),
            ],
          ),
        ),
      );
    }

    // ── Portrait layout ────────────────────────────────────────────────────
    return Scaffold(
      appBar: AppBar(title: Text(widget.video.title)),
      body: ListView(
        padding: EdgeInsets.zero,
        children: [
          _buildVideoWithControls(context),
        ],
      ),
    );
  }

  Widget _buildLandscapeControls(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          VideoProgressIndicator(
            _controller,
            allowScrubbing: true,
            padding: const EdgeInsets.symmetric(vertical: 4),
          ),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              IconButton(
                onPressed: () => _seekRelative(const Duration(seconds: -10)),
                icon: const Icon(Icons.replay_10, color: Colors.white),
                iconSize: 20,
              ),
              IconButton(
                onPressed: () {
                  if (_controller.value.isPlaying) {
                    _controller.pause();
                  } else {
                    _controller.play();
                  }
                  setState(() {});
                },
                icon: Icon(
                  _controller.value.isPlaying
                      ? Icons.pause_circle
                      : Icons.play_circle,
                  color: Colors.white,
                ),
                iconSize: 28,
              ),
              IconButton(
                onPressed: () => _seekRelative(const Duration(seconds: 10)),
                icon: const Icon(Icons.forward_10, color: Colors.white),
                iconSize: 20,
              ),
              IconButton(
                onPressed: _increaseVolume,
                icon: const Icon(Icons.volume_up, color: Colors.white),
                iconSize: 20,
                tooltip: 'Increase volume',
              ),
              IconButton(
                onPressed: _openSettings,
                icon: const Icon(Icons.settings, color: Colors.white),
                iconSize: 20,
                tooltip: 'Playback settings',
              ),
              const Spacer(),
              Text(
                '${_playbackSpeed}x',
                style: const TextStyle(color: Colors.white70, fontSize: 12),
              ),
              const SizedBox(width: 8),
            ],
          ),
        ],
      ),
    );
  }
}