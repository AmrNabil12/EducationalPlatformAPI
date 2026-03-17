import 'package:flutter/material.dart';
import 'screens/login_screen.dart';
import 'screens/months_screen.dart';
import 'services/api_service.dart';
import 'services/auth_service.dart';
import 'services/crypto_service.dart';
import 'services/device_service.dart';
import 'services/key_service.dart';
import 'services/playback_service.dart';

void main() {
  runApp(const EducationalPlatformApp());
}

class EducationalPlatformApp extends StatefulWidget {
  const EducationalPlatformApp({super.key});

  @override
  State<EducationalPlatformApp> createState() => _EducationalPlatformAppState();
}

class _EducationalPlatformAppState extends State<EducationalPlatformApp> {
  final ApiService _apiService = ApiService();
  final AuthService _authService = AuthService();
  final DeviceService _deviceService = DeviceService();
  final KeyService _keyService = KeyService();
  final CryptoService _cryptoService = CryptoService();

  late final PlaybackService _playbackService = PlaybackService(
    apiService: _apiService,
    keyService: _keyService,
    cryptoService: _cryptoService,
  );

  bool? _isAuthenticated;

  @override
  void initState() {
    super.initState();
    _bootstrap();
  }

  Future<void> _bootstrap() async {
    final tokenFuture = _authService.getToken();
    await Future.delayed(const Duration(seconds: 2));
    final token = await tokenFuture;
    if (!mounted) return;
    setState(() {
      _isAuthenticated = token != null && token.isNotEmpty;
    });
  }

  void _onLoginSuccess() {
    setState(() {
      _isAuthenticated = true;
    });
  }

  Future<void> _onLogout() async {
    await _authService.clearSession();
    if (!mounted) return;
    setState(() {
      _isAuthenticated = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'Educational Platform',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.indigo),
        scaffoldBackgroundColor: const Color(0xFFF5F7FC),
        appBarTheme: const AppBarTheme(
          centerTitle: false,
          elevation: 0,
        ),
        cardTheme: CardThemeData(
          elevation: 1,
          color: Colors.white,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
          margin: const EdgeInsets.symmetric(vertical: 6),
        ),
        elevatedButtonTheme: ElevatedButtonThemeData(
          style: ElevatedButton.styleFrom(
            padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 16),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          ),
        ),
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: Colors.white,
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: const BorderSide(width: 1.6),
          ),
        ),
        useMaterial3: true,
      ),
      home: _isAuthenticated == null
          ? const _EducationSplashScreen()
          : (_isAuthenticated!
              ? MonthsScreen(
                  apiService: _apiService,
                  authService: _authService,
                  playbackService: _playbackService,
                  onLogout: _onLogout,
                )
              : LoginScreen(
                  apiService: _apiService,
                  authService: _authService,
                  deviceService: _deviceService,
                  keyService: _keyService,
                  onLoginSuccess: _onLoginSuccess,
                )),
    );
  }
}

class _EducationSplashScreen extends StatelessWidget {
  const _EducationSplashScreen();

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return Scaffold(
      body: Container(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            colors: [
              colorScheme.primary,
              colorScheme.primaryContainer,
            ],
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
          ),
        ),
        child: SafeArea(
          child: Center(
            child: TweenAnimationBuilder<double>(
              tween: Tween(begin: 0.94, end: 1),
              duration: const Duration(milliseconds: 900),
              curve: Curves.easeOutBack,
              builder: (context, value, child) {
                return Opacity(
                  opacity: value.clamp(0, 1),
                  child: Transform.scale(scale: value, child: child),
                );
              },
              child: const Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  CircleAvatar(
                    radius: 48,
                    backgroundColor: Colors.white,
                    child: Icon(Icons.school_rounded, size: 46),
                  ),
                  SizedBox(height: 16),
                  Text(
                    'Educational Platform',
                    style: TextStyle(
                      color: Colors.white,
                      fontSize: 24,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  SizedBox(height: 6),
                  Text(
                    'Secure Learning Experience',
                    style: TextStyle(color: Colors.white70),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
