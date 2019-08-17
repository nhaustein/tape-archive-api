/* define modules */
const express = require("express");
const https = require("https");
const spawn = require("child_process").spawn
const glob = require("glob");
const shortid = require("shortid");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const js2xmlparser = require("js2xmlparser");
const passport = require("passport");
const LdapStrategy = require("passport-ldapauth");
const WindowsStrategy = require("passport-windowsauth");
const bodyParser = require("body-parser");
const sprintf = require("sprintf-js").sprintf;
const morgan = require("morgan");
const pkgcloud = require("pkgcloud");
const process = require("process");

/* define global constants */
/* this is the secret of the ca-cert */
var secret = "IBM Spectrum Archive EE";
/* userName and password currently used in /login endpoint */
var userName = "admin"
var userPw = "Passw0rd"
var bytes = 1024*1024*1024;
var ver = "1.0"

/* assign environment variables or defaults */
// http port to be used by the API
var httpPort = process.env.EEAPI_PORT || 80; 
// when using SSH then the API does not run on eenode
var useSSH = process.env.EEAPI_USESSH || true;
// ssh Port
var sshPort = process.env.EEAPI_SSHPORT || 22;
// ssh and scp user 
var sshUser = process.env.EEAPI_SSHUSER || "root";
// ssh and scp host address or name
var sshHost = process.env.EEAPI_SSHHOST || "localhost";
// directory and file name prefix for recall filelists on EE node 
var recallFileSpec = process.env.EEAPI_RECALLFILE || "/tmp/recall-list";
// directory and file name prefix for migrate filelists on EE node
var migrateFileSpec = process.env.EEAPI_MIGRATEFILE || "/tmp/migrate-list";
// name of the key file used for ssh
var sshKey = process.env.EEAPI_KEYFILE || "/root/.ssh/id_rsa";


/* instantiate express object */
var app = express();
var adminRoutes = express.Router();
app.use(morgan("common"));
app.use(bodyParser.urlencoded({extended: false}));
app.use(bodyParser.json());
app.use(passport.initialize());


/******************************************************************************************
  adminRoutes.use
  Authenticate using http basic authentication
  
  Example: curl -H "Authorization: Basic YXBpdXNlcjphcGlwd2Q="
  YXBpdXNlcjphcGlwd2Q= is the base 64 encoded string with my credentials apiuser:apipwd

TODO:
- implement basic auth https://www.npmjs.com/package/basic-auth
var auth = require('basic-auth')
credentials.name, 
credentials.pass
*/
adminRoutes.use(function(req, res, next) {
  var token = req.headers["x-auth-token"];
  if (token) {
    jwt.verify(token, secret, function(err, decoded) {
      if (err) {
	res.send("***** ERROR: Failed to authenicate ("+err+") *****\n");
      }
      else {
	req.decoded = decoded;
        next();
      }
    });
  }
  else {
      res.status(403).send("***** INFO: No token provided *****\n");
  }
});
/******************************************************************************************
  app.use
  Endpoints that require authentication:
  - recall synchronous
  - migrate synchronous

Todo:
- add endpoints
*/


/*****************************************************************************************
  Endpoint: /login
  Validates username and password
  Returns 401 if user does not match, otherwise 200 with auth-token
  
  Example: curl -X POST -H "x-auth-user: admin" -H "x-auth-key: Passw0rd" http://localhost/login

*****************************************************************************************/
app.post("/login", function(req, res) {
  var format = req.query.format;

  //Need to validate username/password
  if (!(req.headers["x-auth-user"] === userName && req.headers["x-auth-key"] === userPw)) {
    res.status(401).send("***** ERROR: Wrong user or password *****\n");
  }
  else {
    var token = jwt.sign({username: req.headers["x-auth-user"], password: req.headers["x-auth-key"]}, secret, {expiresIn: 60*60*24});
    if (format === "json") {
      res.type("json");
      res.json({Response: {"x-auth-token": token}});
    }
    else {
      res.type("text");
      res.send("x-auth-token: "+token+" \n")
    }
  }
});


/*****************************************************************************************
  Endpoint: /about
  Prints the available endpoints
  
  Example: curl -X GET http://localhost/about

TODO:
- produce json output
*****************************************************************************************/
app.get("/about", function(req, res) {
  res.write("Welcome to the Spectrum Archive EE REST API page\n");
  app._router.stack.forEach(function(r){
    if (r.route && r.route.path){
      res.write(sprintf("%4s %s\n", Object.keys(r.route.methods).toString().toUpperCase(), r.route.path));
    }
  });
  res.end();
});


/*****************************************************************************************
  Endpoint: /status
  Check Spectrum Archive EE status by running eeadm node list
  Returns output of eeadm node list
  
  Example: curl -X GET http://localhost/status

*****************************************************************************************/
app.get("/status", function(req, res) {
  let format = req.query.format || "text";

  runCommand("/opt/ibm/ltfsee/bin/eeadm node list", format, res);
});


/*****************************************************************************************
  Endpoint: /info/tape|drive|node|pool|library
  Runs command: eeadm <comp> list
  Provide eeadm info command output
  
  Example: curl -X GET http://localhost/info/<cmd>
*****************************************************************************************/
app.get("/info/:cmd(tape|drive|node|pool|library)", function(req, res) {
  let format = req.query.format || "text";
  let cmd = req.params.cmd;

  runCommand("/opt/ibm/ltfsee/bin/eeadm "+cmd+" list", format, res);
});


/*****************************************************************************************
  Endpoint: /filestate/<path-and-file-name>
  Runs command: eeadm file state on given file
  Provide eeadm file state output
  
  Example: curl -X GET http://localhost/filestate/<path-and-file-name>

TODO:
- tolerate blank in filename
*****************************************************************************************/
app.get("/filestate/*", function(req, res) {
  let format = req.query.format || "text";
  let output = "";
  let file = "/"+req.params[0];
  let worker;

  // run the command with fixed format text because eeadm file state does not support json
  worker = runCommand("/opt/ibm/ltfsee/bin/eeadm file state "+file, "text", undefined);

  worker.stdout.on("data", function(data) {
    output += data;
  });
  worker.stderr.on("data", function(data) {
    console.log("stderr: "+data);
  });
  worker.on("exit", function(code) {
    if (code === 0 ) {
      if (format === "json") {
        res.type("json");
        res.send(convertFileInfo(code, output)); 
      }
      else {
        res.type("text");
        res.send(output);
      }
    }
    else {
      if (format === "json") {
	    res.status(500).send("{\"Response\": {\"Returncode\": "+code+", \"Message\": \"command eeadm file state failed\"}}\n");
	  }
	  else {
	    res.status(500).send("Error: command eeadm file list  failed with return code "+code+"\n");
	  }
	};
  }); 
});

/*****************************************************************************************
  Endpoint: /tasks/:cmd(active|complete)
  Runs command: eeadm task list [-c] 
  Provide eeadm task list [-c] output
  
  Example: curl -X GET http://localhost/tasks/:cmd(active|all)

*****************************************************************************************/
app.get("/tasks/:cmd(active|all)", function(req, res) {
  let format = req.query.format || "text";
  let filter = req.query.filter;
  let cmd = req.params.cmd;
  var opt = "";

  if (cmd === "all") {
    opt = "-c";
  }
  
  if (filter) {
     runCommand("/opt/ibm/ltfsee/bin/eeadm task list "+opt+" | grep "+filter, format, res);
  }
  else {
     runCommand("/opt/ibm/ltfsee/bin/eeadm task list "+opt, format, res);
  }
});

/*****************************************************************************************
  Endpoint: /taskshow/:taskid
  Runs command: eeadm task show task-ID 
  Provide eeadm task show task-id
  
  Example: curl -X GET http://localhost/taskshow/:task-id
*****************************************************************************************/
app.get("/taskshow/:taskid", function(req, res) {
  let format = req.query.format || "text";
  let taskid = req.params.taskid;

  if (!isNaN(taskid)) {
    runCommand("/opt/ibm/ltfsee/bin/eeadm task show "+taskid, format, res);
  }
  else {
/*  return error */
    console.log("Error: Invalid task-ID, must be a integer number");
    res.status(412).send("Error: Invalid task-ID, must be a integer number\n");
  }
});


/*****************************************************************************************
  Endpoint: /recall
  Obtains file list from request.body
  Copies filelist to EE host
  Runs command: eeadm recall filelist 
  Returns result of the operation
  
  Example: curl -X PUT http://localhost/recall -d "filelist"
*****************************************************************************************/
app.put("/recall", function(req, res) {
  let format = req.query.format || "text";
  let file_list = Object.keys(req.body)[0];
  let worker;
  let tmp_file = "/tmp/ee-restapi-reclist."+shortid.generate();
  let destFile = ""+recallFileSpec+"."+shortid.generate()+"";

  // console.log("DEBUG: request body sting: "+file_list);

  if (file_list === "" || file_list == undefined || file_list == "\n") {
    console.log("Error: recall file list is empty, returning http 412.");
    res.status(412).send("Error: recall file list is empty.\n");
    return;
  }
  
  // write file_list in file tmp_file 
  file_list = file_list.trim();
  try {
    fs.writeFileSync(tmp_file, file_list);
  } catch (err) {
	console.log("Error: writing to file "+tmp_file+", message: "+err.message+", return http 500\n");
    res.status(500).send("Error: creating file list, message: "+err.message+"");
    return;
  }

  // send tmp_file to eenode as file destFile, return 500 (internal server error) if it fails
  worker = runCopy(tmp_file, destFile);
  // capture stdout and check exit code
  worker.stdout.on("data", function(data) {
    console.log("DEBUG: runcopy output: "+data);
  });
  worker.on("exit", function(code) {
    // if runCopy was good then run the command
    if (code === 0 ) {
      // unlink the tmp_file
      fs.unlink(tmp_file, function(err) {
        if (err) {
          console.log("WARNING: unlink "+tmp_file+" failed with err.message \n");  
        } 
      });

      // run the eeadm command
      worker = runCommand("/opt/ibm/ltfsee/bin/eeadm recall "+destFile, format, undefined);
      // capture stdout and check exit code
      worker.stdout.on("data", function(data) {
        console.log("DEBUG: runCommand output: "+data);
      });
      worker.on("exit", function(code) {
        if (code === 0 ) {
          if (format === "json") {
           res.type("json");
           res.send("{\"Response\": {\"Returncode\": \"0\", \"Message\": \"Recall finished.\"}}\n");
          }
          else {
            res.type("text");
            res.send("Recall finished!\n");
          }
        }
        else {
          console.log("Error: recall failed with return code "+code+", returning http 500");
          if (format === "json") response.status(500).send("{\"Response\": {\"Returncode\": "+code+", \"Message\": \"recall failed.\"}}\n");
          else res.status(500).send("Error: recall failed with return code "+code+"\n");
        }
      });
    }
    else {
      console.log("Error: create file list failed with return code "+code+", returning http 500. SSH key may not work.");
      if (format === "json") response.status(500).send("{\"Response\": {\"Returncode\": "+code+", \"Message\": \"create file list failed.\"}}\n");
      else res.status(500).send("Error: create file list failed with return code "+code+"\n");
    }
  }); 
  worker.stderr.on("data", function(data) {
    console.log("stderr: "+data);
  });

});

/*****************************************************************************************
  Endpoint: /migrate
  Obtains file list from request.body and pool name from modifier ?pool1=name?po
  Copies filelist to EE host
  Runs command: eeadm migrate filelist -p pool
  Returns result of the operation
  
  Example: curl -X PUT http://localhost/migrate?pool1=pool1@lib1&pool2=pool2@lib1 -d "filelist"
*****************************************************************************************/
app.put("/migrate", function(req, res) {
  // get format from URL modifier ?format=, default is text
  let format = req.query.format || "text";
  // extract the file names from req.body key field 0
  let file_list = Object.keys(req.body)[0];
  let worker;
  let tmp_file = "/tmp/ee-restapi-miglist."+shortid.generate();
  let destFile = ""+migrateFileSpec+"."+shortid.generate()+"";
  // get pool name from URL modiers
  let pool = [];
  pool[0] = req.query.pool || undefined;
  pool[1] = req.query.pool1 || undefined;
  pool[2] = req.query.pool2 || undefined;
  pool[3] = req.query.pool3 || undefined;
  let pools = "";

  // build the pools string
  for (let i=0; i<=3; i++) {
    if (pool[i]) {
      if (pools === "") {
        pools = pool[i];
      } else {
          pools = ""+pools+","+pool[i]+"";
        }
    }
  }
  console.log("DEBUG: migration destination pools: "+pools);

  // bail out if we do not have a pool
  if (pools === "") {
    console.log("Error: no migration destination pool specified.");
    res.status(412).send("Error: no migration destination pool specified, use modifier ?pool=pool \n");
    // return to prevent continuing this function
    return; 
  }

  // console.log("DEBUG: request body sting: "+file_list);

  // bail out if the file_list is empty or undefined (-d not given)
  if (file_list === "" || file_list == undefined || file_list == "\n") {
    console.log("Error: migrate file list is empty.");
    res.status(412).send("Error: migrate file list is empty.\n");
    return;
  }

  // write file_list in file tmp_file 
  file_list = file_list.trim();
  try {
    fs.writeFileSync(tmp_file, file_list);
  } catch (err) {
	console.log("Error: writing to file "+tmp_file+", message: "+err.message+", return http 500\n");
    res.status(500).send("Error: creating file list, message: "+err.message+"");
    return;
  }

  //send tmp_file to eenode as file destFile, return 500 (internal server error) if it fails
  worker = runCopy(tmp_file, destFile);
  // capture stdout and exit codes
  worker.stdout.on("data", function(data) {
    console.log("DEBUG: runcopy output: "+data);
  });
  worker.on("exit", function(code) {
    // if runCopy was good, run the command
    if (code === 0 ) {
      // unlink the tmp_file
      fs.unlink(tmp_file, function(err) {
        if (err) {
          console.log("WARNING: unlink "+tmp_file+" failed with err.message \n");  
        } 
      });

      // run eeadm command
      worker = runCommand("/opt/ibm/ltfsee/bin/eeadm migrate "+destFile+" -p "+pools+"", format, undefined);
      // capture stdout and exit codes
      worker.stdout.on("data", function(data) {
        console.log("DEBUG: runCommand output: "+data);
      });
      worker.on("exit", function(code) {
        if (code === 0 ) {
          if (format === "json") {
            res.type("json");
            res.send("{Response: {Returncode: 0, Message: Migrate finished}}\n");
          }
          else {
            res.type("text");
            res.send("Migrate finished!\n");
          }
        }
        else {
          console.log("Error: migrate failed with return code "+code+", returning http 500.");
          if (format === "json") response.status(500).send("{\"Response\": {\"Returncode\": "+code+", \"Message\": \"migrate failed.\"}}\n");
          else res.status(500).send("Error: migrate failed with return code "+code+"\n");
        }
       });
     }
     else {
       console.log("Error: create file list for migrate failed with return code "+code+",returning http 500");
       if (format === "json") response.status(500).send("{\"Response\": {\"Returncode\": "+code+", \"Message\": \"create file list for migrate failed.\"}}\n");
       else res.status(500).send("Error: create file list failed for migrate with return code: "+code+"\n");
     }
     }); 
  worker.stderr.on("data", function(data) {
    console.log("stderr: "+data);
  });
});


/*******************************************************************************
 MAIN Code
*******************************************************************************/
app.listen(httpPort)

/* print welcome */
console.log("EE Action API version "+ver+" started on port "+httpPort);
console.log("DEBUG: useSSH="+useSSH+" sshPort="+sshPort+" sshkeyfile="+sshKey+" sshUser="+sshUser+" sshHost="+sshHost+" recallDir="+recallFileSpec+" migrateDir="+migrateFileSpec+"");

/********************************************************************
  HELPER FUNCTIONS
********************************************************************/

/********************************************************************
   Function: runCommand
   Input: 
    1. command string to run
    2. output format (determines whether to add --json
   Return: 
     output: command output as spawn object
*********************************************************************/
function runCommand(command, format, response) {
  let cmdPrefix = "";
  let cmdPostfix = "";
  let proc;
  let output = "";

  if (format === "json") {
    cmdPostfix = " --json"
  }

  if (useSSH) {
    cmdPrefix = "/usr/bin/ssh -o BatchMode=yes -i "+sshKey+" "+sshUser+"@"+sshHost+" ";
    console.log("DEBUG: running command: "+cmdPrefix+""+command+""+cmdPostfix+"");
    proc = spawn("/bin/sh",["-c", cmdPrefix+command+cmdPostfix]);
  }
  else {
    console.log("DEBUG: running command: "+command+cmdPostfix);
    proc = spawn("/bin/sh",["-c", command+cmdPostfix]);
  };

  // this is common code for some enpoints, but not for all
  if (response) {
	  proc.stdout.on("data", function(data) {
		output += data;
	  });
	  proc.stderr.on("data", function(data) {
		console.log("stderr: "+data);
	  });
	  proc.on("exit", function(code) {
		if (format == "json") { 
		  response.type("json");
		}
		else {
		  response.type("text");
		}

		if (code === 0 ) {
		  response.send(output);
		}
		else {
          console.log("Error: command "+command+"  failed with return code "+code+"");
		  if (format === "json") {
			 response.status(500).send("{\"Response\": {\"Returncode\": "+code+", \"Message\": \"command "+command+" failed\"}}\n");
		  }
		  else {
			response.status(500).send("Error: command "+command+" failed with return code "+code+"\n");
		  }
		};
	  }); 
  }
  return(proc);
}


/********************************************************************
   Function: runCopy
   Input: source file, destination file
   Processing: runs remote copy command and returns status
   Return: result of the copy operation as spawn object
*********************************************************************/
function runCopy(sourceFile, destFile) {
  var copyCmd = "";
  var proc = "";

  if (useSSH) {
    copyCmd = "/usr/bin/scp -o BatchMode=yes -i "+sshKey+" "+sourceFile+" "+sshUser+"@"+sshHost+":"+destFile+"";
    console.log("DEBUG: running command: "+copyCmd+"");
    proc = spawn("/bin/sh",["-c", copyCmd]);
  }
  else {
    copyCmd = "/usr/bin/cp "+sourceFile+" "+destFile+"";
    console.log("DEBUG: running command: "+copyCmd);
    proc = spawn("/bin/sh",["-c", copyCmd]);
  };

  return(proc);
}

/********************************************************************
   Function: convertFileInfo
   Input: 
     code: return code of the command
     output: text output of eeadm file state
   Processing: runs through the output and creates json format
   Return: returns file state in json format
*********************************************************************/
function convertFileInfo(code, output) {

  var lines = output.trim().split("\n");
  var files = [];
  var file = {};
  var numnames = 0;

  for (let line of lines) {
    // Skip empty lines
    if (line === "") { continue; }

	// Parse line
    let keyvaluepair = line.split(':');

	// Check if this is a new record
	if (keyvaluepair[0] === 'Name') {
	  
	  if (numnames === 0) {
        // Very first record, just count it
        numnames++;
      } else {
        // New record after first one, add previous file to array
        //console.log(file); 
		files.push(file);
		file = new Object();
	  }
    }

	// Add record to object
	file[keyvaluepair[0].toLowerCase()] = keyvaluepair[1];
  }

  // Add last file to array
  // console.log(file); 
  files.push(file);

  return({Response: {Error: code, files: files}});
}
