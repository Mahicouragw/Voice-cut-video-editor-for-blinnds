import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

final localServer = InAppLocalhostServer(documentRoot: 'assets/web', port: 8080);
const localOrigin = 'http://localhost:8080';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    await localServer.start();
    runApp(const VoiceCutApp());
  } catch (_) {
    runApp(const MaterialApp(home: Scaffold(body: Center(child: Text('Could not start the editor. Close and reopen the app.')))));
  }
}

class VoiceCutApp extends StatelessWidget {
  const VoiceCutApp({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'VoiceCut Studio',
    debugShowCheckedModeBanner: false,
    theme: ThemeData.dark(useMaterial3: true),
    home: const EditorPage(),
  );
}

class EditorPage extends StatefulWidget {
  const EditorPage({super.key});
  @override
  State<EditorPage> createState() => _EditorPageState();
}

class _EditorPageState extends State<EditorPage> {
  String? error;
  bool loading = true;
  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('VoiceCut Studio')),
    body: SafeArea(child: Stack(children: [
      InAppWebView(
        initialUrlRequest: URLRequest(url: WebUri('$localOrigin/index.html')),
        initialSettings: InAppWebViewSettings(
          javaScriptEnabled: true,
          mediaPlaybackRequiresUserGesture: true,
          useShouldOverrideUrlLoading: true,
          supportZoom: true,
          allowFileAccessFromFileURLs: false,
          allowUniversalAccessFromFileURLs: false,
        ),
        shouldOverrideUrlLoading: (controller, action) async {
          final origin = action.request.url?.origin;
          return origin == localOrigin ? NavigationActionPolicy.ALLOW : NavigationActionPolicy.CANCEL;
        },
        onWebViewCreated: (controller) {
          controller.addJavaScriptHandler(handlerName: 'shareSubtitles', callback: (args) async {
            final url = await controller.getUrl();
            if (url?.origin != localOrigin || args.length != 2 || args[0] is! String) throw StateError('Invalid subtitle request');
            final text = args[0] as String;
            if (text.length > 3000000) throw StateError('Subtitle file too large');
            final extension = args[1] == 'vtt' ? 'vtt' : 'srt';
            final directory = await getTemporaryDirectory();
            final file = File('${directory.path}/voicecut_captions_${DateTime.now().millisecondsSinceEpoch}.$extension');
            try {
              await file.writeAsString(text);
              await Share.shareXFiles([XFile(file.path, mimeType: extension == 'vtt' ? 'text/vtt' : 'application/x-subrip')], subject: 'VoiceCut captions');
            } finally {
              if (await file.exists()) await file.delete();
            }
            return true;
          });
          controller.addJavaScriptHandler(handlerName: 'shareExport', callback: (args) async {
            final url = await controller.getUrl();
            if (url?.origin != localOrigin || args.length != 2 || args[0] is! String) throw StateError('Invalid export request');
            final encoded = args[0] as String;
            if (encoded.length > 56 * 1024 * 1024) throw StateError('Export too large. Use Chrome for exports larger than 40 MB.');
            final extension = args[1] == 'mp4' ? 'mp4' : 'webm';
            final directory = await getTemporaryDirectory();
            final file = File('${directory.path}/voicecut_${DateTime.now().millisecondsSinceEpoch}.$extension');
            try {
              await file.writeAsBytes(base64Decode(encoded));
              await Share.shareXFiles([XFile(file.path, mimeType: 'video/$extension')], subject: 'VoiceCut export');
            } finally {
              if (await file.exists()) await file.delete();
            }
            return true;
          });
        },
        onPermissionRequest: (controller, request) async {
          final trusted = request.origin.origin == localOrigin;
          final audioOnly = request.resources.isNotEmpty && request.resources.every((r) => r == PermissionResourceType.MICROPHONE);
          final allowed = trusted && audioOnly && await Permission.microphone.request().isGranted;
          return PermissionResponse(resources: request.resources, action: allowed ? PermissionResponseAction.GRANT : PermissionResponseAction.DENY);
        },
        onLoadStop: (controller, url) { if (mounted) setState(() { loading = false; error = null; }); },
        onReceivedError: (controller, request, details) {
          if (request.isForMainFrame == true && mounted) setState(() { loading = false; error = 'Editor could not load. Close and reopen the app.'; });
        },
      ),
      if (loading) const Center(child: CircularProgressIndicator(semanticsLabel: 'Loading editor')),
      if (error != null) Center(child: Text(error!)),
    ])),
  );
}
