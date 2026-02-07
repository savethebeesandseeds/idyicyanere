cmd_Release/idydb.node := ln -f "Release/obj.target/idydb.node" "Release/idydb.node" 2>/dev/null || (rm -rf "Release/idydb.node" && cp -af "Release/obj.target/idydb.node" "Release/idydb.node")
