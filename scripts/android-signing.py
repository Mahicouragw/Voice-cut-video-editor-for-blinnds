"""Used only by the manually requested signed-release job. No secret output."""
from pathlib import Path
import base64, os
root = Path('flutter_app/android')
required = ['ANDROID_KEYSTORE_BASE64','ANDROID_KEYSTORE_PASSWORD','ANDROID_KEY_ALIAS','ANDROID_KEY_PASSWORD']
if any(not os.environ.get(key) for key in required):
    raise SystemExit('Missing signing secrets. See docs/PLAY_STORE_GUIDE.md. Debug builds need no secrets.')
(root/'app/upload-keystore.jks').write_bytes(base64.b64decode(os.environ['ANDROID_KEYSTORE_BASE64'],validate=True))
p = root/'app/build.gradle.kts'
s = p.read_text()
if 'signingConfig = null // VOICECUT_RELEASE_SIGNING' not in s:
    raise SystemExit('Unexpected Flutter Gradle template. Refusing to publish an incorrectly signed release.')
s = s.replace('    buildTypes {', '''    signingConfigs {
        create("release") {
            storeFile = file("upload-keystore.jks")
            storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("ANDROID_KEY_ALIAS")
            keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
        }
    }
    buildTypes {''')
s = s.replace('signingConfig = null // VOICECUT_RELEASE_SIGNING','signingConfig = signingConfigs.getByName("release")')
p.write_text(s)
