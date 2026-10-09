import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';
import 'package:gal/gal.dart';

// The app loads the live VoiceCut website, so website updates apply
// automatically without rebuilding or reinstalling the app.
const siteUrl = 'https://mahicouragw.github.io/Voice-cut-video-editor-for-blinnds/';
const siteOrigin = 'https://mahicouragw.github.io';

final FlutterLocalNotificationsPlugin notificationsPlugin = FlutterLocalNotificationsPlugin();

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await notificationsPlugin.initialize(
    const InitializationSettings(android: AndroidInitializationSettings('@mipmap/ic_launcher')),
  );
  runApp(const VoiceCutApp());
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

// One large file arriving from the page in small base64 parts.
class _ChunkedTransfer {
  _ChunkedTransfer({required this.extension, required this.action, required this.total});
  final String extension;
  final String action;
  final int total;
  final List<int> bytes = [];
  int nextIndex = 0;
  int get received => bytes.length;
  bool get complete => received >= total;
}

class _EditorPageState extends State<EditorPage> {
  InAppWebViewController? webController;
  String? error;
  bool loading = true;
  final Map<String, _ChunkedTransfer> _transfers = {};
  int _transferSeq = 0;
  String _transferExt(dynamic value) => value == 'mp4' ? 'mp4' : 'webm';
  // Save into the device gallery (needs no storage permission on modern
  // Android: Gal writes through MediaStore) or open the share sheet.
  Future<void> _deliverVideoBytes(List<int> bytes, String extension, String action) async {
    final directory = await getTemporaryDirectory();
    final file = File('${directory.path}/voicecut_${DateTime.now().millisecondsSinceEpoch}.$extension');
    await file.writeAsBytes(bytes, flush: true);
    try {
      if (action == 'save') {
        await Gal.putVideo(file.path, album: 'VoiceCut');
      } else {
        await Share.shareXFiles([XFile(file.path, mimeType: 'video/$extension')], subject: 'VoiceCut export');
      }
    } finally {
      if (await file.exists()) await file.delete();
    }
  }
  void retry() {
    setState(() { loading = true; error = null; });
    webController?.reload();
  }
  @override
  // Fullscreen WebView with no native header: TalkBack linear navigation
  // starts inside the page instead of getting stuck on an app bar.
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(child: Stack(children: [
      InAppWebView(
        initialUrlRequest: URLRequest(url: WebUri(siteUrl)),
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
          return origin == siteOrigin ? NavigationActionPolicy.ALLOW : NavigationActionPolicy.CANCEL;
        },
        onWebViewCreated: (controller) {
          webController = controller;
          controller.addJavaScriptHandler(handlerName: 'shareSubtitles', callback: (args) async {
            final url = await controller.getUrl();
            if (url?.origin != siteOrigin || args.length != 2 || args[0] is! String) throw StateError('Invalid subtitle request');
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
            if (url?.origin != siteOrigin || args.length != 2 || args[0] is! String) throw StateError('Invalid export request');
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
          controller.addJavaScriptHandler(handlerName: 'saveExport', callback: (args) async {
            final url = await controller.getUrl();
            if (url?.origin != siteOrigin || args.length != 2 || args[0] is! String) throw StateError('Invalid export request');
            final encoded = args[0] as String;
            if (encoded.length > 56 * 1024 * 1024) throw StateError('Export too large for one message. Use the chunked transfer.');
            await _deliverVideoBytes(base64Decode(encoded), _transferExt(args[1]), 'save');
            return true;
          });
          controller.addJavaScriptHandler(handlerName: 'shareExportStart', callback: (args) async {
            final url = await controller.getUrl();
            if (url?.origin != siteOrigin || args.length != 3 || args[0] is! String || args[1] is! String || args[2] is! num) throw StateError('Invalid export request');
            final total = (args[2] as num).toInt();
            if (total <= 0 || total > 2 * 1024 * 1024 * 1024) throw StateError('Export size not supported.');
            final id = 't${DateTime.now().millisecondsSinceEpoch}_${_transferSeq++}';
            _transfers[id] = _ChunkedTransfer(extension: _transferExt(args[0]), action: args[1] == 'save' ? 'save' : 'share', total: total);
            return id;
          });
          controller.addJavaScriptHandler(handlerName: 'shareExportChunk', callback: (args) async {
            final url = await controller.getUrl();
            if (url?.origin != siteOrigin || args.length != 3 || args[0] is! String || args[1] is! num || args[2] is! String) throw StateError('Invalid export part');
            final transfer = _transfers[args[0] as String];
            if (transfer == null) throw StateError('Unknown export transfer');
            if ((args[1] as num).toInt() != transfer.nextIndex) throw StateError('Export parts arrived out of order');
            final part = base64Decode(args[2] as String);
            if (transfer.received + part.length > transfer.total) throw StateError('Export larger than announced');
            transfer.bytes.addAll(part);
            transfer.nextIndex++;
            return transfer.received;
          });
          controller.addJavaScriptHandler(handlerName: 'shareExportFinish', callback: (args) async {
            final url = await controller.getUrl();
            if (url?.origin != siteOrigin || args.length != 1 || args[0] is! String) throw StateError('Invalid export request');
            final transfer = _transfers.remove(args[0] as String);
            if (transfer == null) throw StateError('Unknown export transfer');
            if (!transfer.complete) throw StateError('Export is incomplete');
            await _deliverVideoBytes(transfer.bytes, transfer.extension, transfer.action);
            return true;
          });
          controller.addJavaScriptHandler(handlerName: 'shareExportAbort', callback: (args) async {
            if (args.isNotEmpty && args[0] is String) _transfers.remove(args[0] as String);
            return true;
          });
          controller.addJavaScriptHandler(handlerName: 'requestNotificationPermission', callback: (args) async {
            final url = await controller.getUrl();
            if (url?.origin != siteOrigin) throw StateError('Invalid notification request');
            final android = notificationsPlugin.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
            return await android?.requestNotificationsPermission() ?? false;
          });
          controller.addJavaScriptHandler(handlerName: 'showNotification', callback: (args) async {
            final url = await controller.getUrl();
            if (url?.origin != siteOrigin || args.length != 2 || args[0] is! String || args[1] is! String) throw StateError('Invalid notification request');
            final title = (args[0] as String).trim();
            final body = (args[1] as String).trim();
            if (title.isEmpty || body.isEmpty || title.length > 100 || body.length > 500) throw StateError('Invalid notification text');
            const details = NotificationDetails(android: AndroidNotificationDetails(
              'voicecut_jobs', 'VoiceCut job updates',
              channelDescription: 'Completion alerts for captions, cleanup, silence removal and export',
              importance: Importance.high, priority: Priority.high,
            ));
            await notificationsPlugin.show(DateTime.now().millisecondsSinceEpoch ~/ 1000, title, body, details);
            return true;
          });
        },
        onPermissionRequest: (controller, request) async {
          final trusted = request.origin.origin == siteOrigin;
          final captureResources = <PermissionResourceType>{
            PermissionResourceType.CAMERA,
            PermissionResourceType.MICROPHONE,
          };
          final supportedRequest = request.resources.isNotEmpty && request.resources.every(captureResources.contains);
          var granted = trusted && supportedRequest;
          if (granted && request.resources.contains(PermissionResourceType.CAMERA)) {
            granted = await Permission.camera.request().isGranted;
          }
          if (granted && request.resources.contains(PermissionResourceType.MICROPHONE)) {
            granted = await Permission.microphone.request().isGranted;
          }
          return PermissionResponse(resources: request.resources, action: granted ? PermissionResponseAction.GRANT : PermissionResponseAction.DENY);
        },
        onLoadStop: (controller, url) { if (mounted) setState(() { loading = false; error = null; }); },
        onReceivedError: (controller, request, details) {
          if (request.isForMainFrame == true && mounted) setState(() { loading = false; error = 'Could not load the editor. Check your internet connection, then retry.'; });
        },
      ),
      if (loading) const Center(child: CircularProgressIndicator(semanticsLabel: 'Loading editor')),
      if (error != null) Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
        Padding(padding: const EdgeInsets.all(16), child: Text(error!, textAlign: TextAlign.center)),
        ElevatedButton(onPressed: retry, child: const Text('Retry')),
      ])),
    ])),
  );
}
