# Third-party notices

DSH Mobile embeds the official DeepSeek Harness 0.1.6-alpha.1 npm runtime and its MIT-licensed browser Worker, with mobile persistence and service-bridge modifications. Upstream: https://github.com/deepseek-ai/deepseek-harness. Copyright DeepSeek contributors.

The virtual runtime image retains the package manifests and published licence files of its dependency graph. `public/runtime/build.json` records the exact image and original/modified Worker digests. The packer uses the upstream browser replacements for native-only components; it does not distribute native desktop executables inside the mobile Worker.

The mobile interface uses React and React DOM (MIT), Lucide icons (ISC), and a purpose-built DSH mark. Zod (MIT) is prebundled at build time to preserve its browser API across the Worker's CommonJS module loader. The iOS container uses system SwiftUI, WebKit, UIKit and Network frameworks.

## MIT licence for incorporated DeepSeek Harness code

Copyright (c) DeepSeek contributors.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
