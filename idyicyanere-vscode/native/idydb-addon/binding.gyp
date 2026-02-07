{
  "targets": [
    {
      "target_name": "idydb",
      "sources": [
        "addon.cpp",
        "idydb/impl/db.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "idydb/include"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": [
        "NODE_ADDON_API_DISABLE_CPP_EXCEPTIONS"
      ],
      "cflags_cc": [ "-std=c++17" ],

      "conditions": [
        ["OS==\"linux\"", {
          "libraries": [ "-lssl", "-lcrypto" ]
        }],

        ["OS==\"mac\"", {
          "xcode_settings": {
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "MACOSX_DEPLOYMENT_TARGET": "10.15"
          },
          "libraries": [ "-lssl", "-lcrypto" ],
          "include_dirs": [
            "<!@(node -p \"require('node-addon-api').include\")",
            "idydb/include",
            "<!(echo ${OPENSSL_INCLUDE_DIR:-})"
          ],
          "library_dirs": [
            "<!(echo ${OPENSSL_LIB_DIR:-})"
          ]
        }],

        ["OS==\"win\"", {
          "defines": [
            "NOMINMAX",
            "WIN32_LEAN_AND_MEAN"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "LanguageStandard": "stdcpp17"
            }
          },
          "include_dirs": [
            "<!@(node -p \"require('node-addon-api').include\")",
            "idydb/include",
            "<!(echo %OPENSSL_INCLUDE_DIR%)"
          ],
          "libraries": [
            "<!(echo %OPENSSL_LIB_DIR%\\\\libssl.lib)",
            "<!(echo %OPENSSL_LIB_DIR%\\\\libcrypto.lib)"
          ]
        }]
      ]
    }
  ]
}
