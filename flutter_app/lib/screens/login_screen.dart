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

class _LoginScreenState extends State<LoginScreen> {
  final TextEditingController _nameController = TextEditingController();
  final TextEditingController _serialController = TextEditingController();
  bool _loading = false;
  String? _error;

  @override
  void dispose() {
    _nameController.dispose();
    _serialController.dispose();
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
      if (mounted) {
        setState(() => _loading = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return Scaffold(
      appBar: AppBar(title: const Text('Student Sign-in')),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Card(
              child: Padding(
                padding: const EdgeInsets.all(20),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Icon(
                      Icons.school_rounded,
                      size: 46,
                      color: colorScheme.primary,
                    ),
                    const SizedBox(height: 10),
                    Text(
                      'Welcome to Educational Platform',
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.titleMedium?.copyWith(
                            fontWeight: FontWeight.w700,
                          ),
                    ),
                    const SizedBox(height: 8),
                    const Text(
                      'Enter your name and serial number to continue.',
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 18),
                    TextField(
                      controller: _nameController,
                      textInputAction: TextInputAction.next,
                      decoration: const InputDecoration(
                        labelText: 'Your Name',
                        hintText: 'e.g. Ahmed Ali',
                        prefixIcon: Icon(Icons.person_outline),
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _serialController,
                      textInputAction: TextInputAction.done,
                      onSubmitted: (_) => _login(),
                      decoration: const InputDecoration(
                        labelText: 'Serial Number',
                        hintText: 'EDU-XXXX-XXXX-XXXX',
                        prefixIcon: Icon(Icons.vpn_key_outlined),
                      ),
                    ),
                    if (_error != null) ...[
                      const SizedBox(height: 12),
                      Text(
                        _error!,
                        style: TextStyle(color: Theme.of(context).colorScheme.error),
                      ),
                    ],
                    const SizedBox(height: 16),
                    ElevatedButton.icon(
                      onPressed: _loading ? null : _login,
                      icon: _loading
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.login),
                      label: Text(_loading ? 'Signing In...' : 'Sign In'),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
