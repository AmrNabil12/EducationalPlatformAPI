import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../services/api_service.dart';
import '../services/auth_service.dart';
import '../services/device_service.dart';
import '../services/key_service.dart';

class LoginScreen extends StatefulWidget {
  final ApiService apiService;
  final AuthService authService;
  final DeviceService deviceService;
  final KeyService keyService;
  final VoidCallback onLoginSuccess;

  const LoginScreen({
    super.key,
    required this.apiService,
    required this.authService,
    required this.deviceService,
    required this.keyService,
    required this.onLoginSuccess,
  });

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen>
    with TickerProviderStateMixin {
  final TextEditingController _nameController = TextEditingController();
  final TextEditingController _serialController = TextEditingController();
  final FocusNode _nameFocus = FocusNode();
  final FocusNode _serialFocus = FocusNode();

  bool _loading = false;
  String? _error;

  late final AnimationController _bgAnimController;
  late final AnimationController _cardAnimController;
  late final AnimationController _orbAnimController;

  late final Animation<double> _cardSlide;
  late final Animation<double> _cardFade;
  late final Animation<double> _orbRotate;

  @override
  void initState() {
    super.initState();

    _bgAnimController = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 8),
    )..repeat(reverse: true);

    _orbAnimController = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 12),
    )..repeat();

    _orbRotate = Tween<double>(begin: 0, end: 2 * math.pi).animate(
      CurvedAnimation(parent: _orbAnimController, curve: Curves.linear),
    );

    _cardAnimController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 800),
    );

    _cardSlide = Tween<double>(begin: 60, end: 0).animate(
      CurvedAnimation(parent: _cardAnimController, curve: Curves.easeOutCubic),
    );

    _cardFade = Tween<double>(begin: 0, end: 1).animate(
      CurvedAnimation(parent: _cardAnimController, curve: Curves.easeOut),
    );

    Future.delayed(const Duration(milliseconds: 200), () {
      if (mounted) _cardAnimController.forward();
    });
  }

  @override
  void dispose() {
    _nameController.dispose();
    _serialController.dispose();
    _nameFocus.dispose();
    _serialFocus.dispose();
    _bgAnimController.dispose();
    _cardAnimController.dispose();
    _orbAnimController.dispose();
    super.dispose();
  }

  Future<void> _login() async {
    final displayName = _nameController.text.trim();
    final serial = _serialController.text.trim();

    if (displayName.isEmpty) {
      setState(() => _error = 'Please enter your name');
      return;
    }
    if (serial.isEmpty) {
      setState(() => _error = 'Please enter your serial number');
      return;
    }

    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final deviceId = await widget.deviceService.getOrCreateDeviceId();
      final publicKeyPem = await widget.keyService.getPublicKeyPem();

      final session = await widget.apiService.login(
        serial: serial,
        deviceId: deviceId,
        publicKeyPem: publicKeyPem,
      );

      await widget.authService.saveSession(session, displayName: displayName);
      if (!mounted) return;
      widget.onLoginSuccess();
    } catch (e) {
      setState(() => _error = e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    // Deep navy + electric teal + amber accent palette
    const Color deepNavy = Color(0xFF0A0E2A);
    const Color midNavy = Color(0xFF111840);
    const Color teal = Color(0xFF00D4B8);
    const Color tealDark = Color(0xFF00A896);
    const Color amber = Color(0xFFFFB347);
    const Color coral = Color(0xFFFF6B6B);

    return Scaffold(
      body: AnimatedBuilder(
        animation: _bgAnimController,
        builder: (context, child) {
          final t = _bgAnimController.value;
          return Container(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [
                  deepNavy,
                  Color.lerp(midNavy, const Color(0xFF0D1F3C), t)!,
                  Color.lerp(const Color(0xFF0A1628), deepNavy, t)!,
                ],
                stops: const [0, 0.5, 1],
              ),
            ),
            child: child,
          );
        },
        child: Stack(
          children: [
            // ── Decorative animated orbs ──────────────────────────────
            AnimatedBuilder(
              animation: _orbRotate,
              builder: (context, _) {
                return Stack(
                  children: [
                    // Large teal orb — top left
                    Positioned(
                      top: -80 + 30 * math.sin(_orbRotate.value),
                      left: -60 + 20 * math.cos(_orbRotate.value),
                      child: _Orb(
                        size: 260,
                        color: teal.withValues(alpha: 0.15),
                      ),
                    ),
                    // Medium amber orb — top right
                    Positioned(
                      top: 40 + 20 * math.cos(_orbRotate.value * 0.7),
                      right: -40 + 15 * math.sin(_orbRotate.value * 0.7),
                      child: _Orb(
                        size: 180,
                        color: amber.withValues(alpha: 0.12),
                      ),
                    ),
                    // Small coral orb — bottom left
                    Positioned(
                      bottom: 100 + 25 * math.sin(_orbRotate.value * 0.5),
                      left: 20 + 15 * math.cos(_orbRotate.value * 0.5),
                      child: _Orb(
                        size: 140,
                        color: coral.withValues(alpha: 0.1),
                      ),
                    ),
                    // Tiny teal orb — bottom right
                    Positioned(
                      bottom: 60 + 20 * math.cos(_orbRotate.value * 1.2),
                      right: 30 + 20 * math.sin(_orbRotate.value * 1.2),
                      child: _Orb(
                        size: 120,
                        color: tealDark.withValues(alpha: 0.13),
                      ),
                    ),
                  ],
                );
              },
            ),

            // ── Grid pattern overlay ──────────────────────────────────
            Positioned.fill(
              child: CustomPaint(painter: _GridPainter()),
            ),

            // ── Main content ──────────────────────────────────────────
            SafeArea(
              child: Center(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.symmetric(
                      horizontal: 24, vertical: 32),
                  child: AnimatedBuilder(
                    animation: _cardAnimController,
                    builder: (context, child) {
                      return Opacity(
                        opacity: _cardFade.value,
                        child: Transform.translate(
                          offset: Offset(0, _cardSlide.value),
                          child: child,
                        ),
                      );
                    },
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 420),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          // ── Logo area ───────────────────────────────
                          _buildLogo(teal, amber),
                          const SizedBox(height: 36),

                          // ── Card ────────────────────────────────────
                          _buildCard(teal, tealDark, amber, coral),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildLogo(Color teal, Color amber) {
    return Column(
      children: [
        // Hexagon-ish logo container
        Container(
          width: 88,
          height: 88,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            gradient: LinearGradient(
              colors: [teal, const Color(0xFF0097A7)],
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
            ),
            boxShadow: [
              BoxShadow(
                color: teal.withValues(alpha: 0.4),
                blurRadius: 28,
                spreadRadius: 2,
              ),
            ],
          ),
          child: const Icon(
            Icons.school_rounded,
            size: 44,
            color: Colors.white,
          ),
        ),
        const SizedBox(height: 20),
        const Text(
          'Educational Platform',
          style: TextStyle(
            color: Colors.white,
            fontSize: 26,
            fontWeight: FontWeight.w800,
            letterSpacing: -0.5,
          ),
        ),
        const SizedBox(height: 6),
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 28,
              height: 2,
              decoration: BoxDecoration(
                color: teal,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            const SizedBox(width: 8),
            Text(
              'Secure Learning Experience',
              style: TextStyle(
                color: Colors.white.withValues(alpha: 0.55),
                fontSize: 13,
                letterSpacing: 0.3,
              ),
            ),
            const SizedBox(width: 8),
            Container(
              width: 28,
              height: 2,
              decoration: BoxDecoration(
                color: teal,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ],
        ),
      ],
    );
  }

  Widget _buildCard(
      Color teal, Color tealDark, Color amber, Color coral) {
    return Container(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(28),
        color: Colors.white.withValues(alpha: 0.06),
        border: Border.all(
          color: Colors.white.withValues(alpha: 0.12),
          width: 1.2,
        ),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.3),
            blurRadius: 40,
            offset: const Offset(0, 16),
          ),
        ],
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(28),
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              // Header
              Row(
                children: [
                  Container(
                    width: 4,
                    height: 22,
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        colors: [teal, amber],
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                      ),
                      borderRadius: BorderRadius.circular(4),
                    ),
                  ),
                  const SizedBox(width: 10),
                  const Text(
                    'Student Sign-in',
                    style: TextStyle(
                      color: Colors.white,
                      fontSize: 18,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Padding(
                padding: const EdgeInsets.only(left: 14),
                child: Text(
                  'Enter your credentials to access your courses',
                  style: TextStyle(
                    color: Colors.white.withValues(alpha: 0.45),
                    fontSize: 12,
                  ),
                ),
              ),
              const SizedBox(height: 26),

              // Name field
              _buildField(
                controller: _nameController,
                focusNode: _nameFocus,
                nextFocus: _serialFocus,
                label: 'Your Name',
                hint: 'e.g. Ahmed Ali',
                icon: Icons.person_outline_rounded,
                teal: teal,
              ),
              const SizedBox(height: 14),

              // Serial field
              _buildField(
                controller: _serialController,
                focusNode: _serialFocus,
                label: 'Serial Number',
                hint: 'EDU-XXXX-XXXX-XXXX',
                icon: Icons.vpn_key_outlined,
                teal: teal,
                onSubmitted: (_) => _login(),
              ),

              // Error
              if (_error != null) ...[
                const SizedBox(height: 14),
                Container(
                  padding: const EdgeInsets.symmetric(
                      horizontal: 14, vertical: 10),
                  decoration: BoxDecoration(
                    color: coral.withValues(alpha: 0.15),
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(
                        color: coral.withValues(alpha: 0.3)),
                  ),
                  child: Row(
                    children: [
                      Icon(Icons.error_outline_rounded,
                          color: coral, size: 16),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          _error!,
                          style: TextStyle(
                              color: coral, fontSize: 12),
                        ),
                      ),
                    ],
                  ),
                ),
              ],

              const SizedBox(height: 24),

              // Sign in button
              _buildSignInButton(teal, tealDark),

              const SizedBox(height: 20),

              // Footer
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(Icons.lock_outline_rounded,
                      size: 12,
                      color: Colors.white.withValues(alpha: 0.3)),
                  const SizedBox(width: 5),
                  Text(
                    'Device-bound secure access',
                    style: TextStyle(
                      color: Colors.white.withValues(alpha: 0.3),
                      fontSize: 11,
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildField({
    required TextEditingController controller,
    required FocusNode focusNode,
    FocusNode? nextFocus,
    required String label,
    required String hint,
    required IconData icon,
    required Color teal,
    ValueChanged<String>? onSubmitted,
  }) {
    return Focus(
      onFocusChange: (_) => setState(() {}),
      child: Builder(
        builder: (context) {
          final focused = focusNode.hasFocus;
          return AnimatedContainer(
            duration: const Duration(milliseconds: 200),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(14),
              color: Colors.white.withValues(alpha: focused ? 0.1 : 0.05),
              border: Border.all(
                color: focused
                    ? teal.withValues(alpha: 0.7)
                    : Colors.white.withValues(alpha: 0.1),
                width: focused ? 1.5 : 1,
              ),
            ),
            child: TextField(
              controller: controller,
              focusNode: focusNode,
              textInputAction: nextFocus != null
                  ? TextInputAction.next
                  : TextInputAction.done,
              onSubmitted: onSubmitted ??
                  (nextFocus != null
                      ? (_) => FocusScope.of(context)
                          .requestFocus(nextFocus)
                      : null),
              style: const TextStyle(
                color: Colors.white,
                fontSize: 14,
                fontWeight: FontWeight.w500,
              ),
              decoration: InputDecoration(
                labelText: label,
                hintText: hint,
                labelStyle: TextStyle(
                  color: focused
                      ? teal
                      : Colors.white.withValues(alpha: 0.45),
                  fontSize: 13,
                ),
                hintStyle: TextStyle(
                  color: Colors.white.withValues(alpha: 0.2),
                  fontSize: 13,
                ),
                prefixIcon: Icon(
                  icon,
                  color: focused
                      ? teal
                      : Colors.white.withValues(alpha: 0.35),
                  size: 20,
                ),
                filled: true,
                fillColor: Colors.transparent,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(14),
                  borderSide: BorderSide.none,
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(14),
                  borderSide: BorderSide.none,
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(14),
                  borderSide: BorderSide.none,
                ),
                contentPadding: const EdgeInsets.symmetric(
                    horizontal: 16, vertical: 14),
              ),
            ),
          );
        },
      ),
    );
  }

  Widget _buildSignInButton(Color teal, Color tealDark) {
    return GestureDetector(
      onTap: _loading ? null : _login,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 200),
        height: 52,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(14),
          gradient: _loading
              ? null
              : LinearGradient(
                  colors: [teal, tealDark],
                  begin: Alignment.centerLeft,
                  end: Alignment.centerRight,
                ),
          color: _loading ? Colors.white.withValues(alpha: 0.1) : null,
          boxShadow: _loading
              ? []
              : [
                  BoxShadow(
                    color: teal.withValues(alpha: 0.35),
                    blurRadius: 16,
                    offset: const Offset(0, 6),
                  ),
                ],
        ),
        child: Center(
          child: _loading
              ? SizedBox(
                  width: 22,
                  height: 22,
                  child: CircularProgressIndicator(
                    strokeWidth: 2.5,
                    color: Colors.white.withValues(alpha: 0.7),
                  ),
                )
              : const Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.login_rounded,
                        color: Colors.white, size: 20),
                    SizedBox(width: 8),
                    Text(
                      'Sign In',
                      style: TextStyle(
                        color: Colors.white,
                        fontSize: 15,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 0.3,
                      ),
                    ),
                  ],
                ),
        ),
      ),
    );
  }
}

// ── Orb widget ────────────────────────────────────────────────────────────────
class _Orb extends StatelessWidget {
  final double size;
  final Color color;

  const _Orb({required this.size, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: color,
      ),
    );
  }
}

// ── Subtle grid background painter ───────────────────────────────────────────
class _GridPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = Colors.white.withValues(alpha: 0.025)
      ..strokeWidth = 0.8;

    const spacing = 40.0;

    for (double x = 0; x < size.width; x += spacing) {
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), paint);
    }
    for (double y = 0; y < size.height; y += spacing) {
      canvas.drawLine(Offset(0, y), Offset(size.width, y), paint);
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}