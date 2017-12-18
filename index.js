const SockJS = require('sockjs-client');
const http = require('http-request');
const Particle = require('particle-api-js');
const fs = require('fs');
const schedule = require('node-schedule');

var particle        = new Particle();
var defaults        = {};
var cloud_connected = false;
var tmp_pct         = 999;
var state_code      = 0;
var tgt             = 200;
var cfg_file        = 'settings.json';

fs.stat(cfg_file, function(err, stat) {
    if(err == null) {
        defaults = JSON.parse(fs.readFileSync(cfg_file, 'utf8'));
        for (var i = 0; i < defaults.printers.length; i++) {
            var printer = defaults.printers[i];
            console.log("Starting Sock to " + printer.name);
            createSock(printer);
        }

        // -- schedule events (currently: dim LEDs off-hours)
        var j_dimmed = schedule.scheduleJob(defaults.button_settings.dim, function(){
            if (cloud_connected) {
                for (var i = 0; i < defaults.printers.length; i++) {
                    var publishEventPr = particle.publishEvent({    name: 'Octoprint_dim_LED', 
                                                                    data: defaults.button_settings.dim_led + '|' + defaults.printers[i].coreid, 
                                                                    auth: defaults.cloud_session.token, 
                                                                    isPrivate : true });
                    publishEventPr.then(
                      function(data) {
                          console.log('Dimmed LED for ' + defaults.printers[i].coreid + ' to ' + defaults.button_settings.dim_led);
                      },
                      function(err) {
                        console.log("Failed to publish event: " + err)
                      }
                    );                
                }  
            } else 
                console.log("No connection to cloud, not adjusting LED brightness.");
        });
        var j_bright = schedule.scheduleJob(defaults.button_settings.bright, function(){
            if (cloud_connected) {
                for (var i = 0; i < defaults.printers.length; i++) {
                    var publishEventPr = particle.publishEvent({    name: 'Octoprint_dim_LED', 
                                                                    data: defaults.button_settings.bright_led + '|' + defaults.printers[i].coreid, 
                                                                    auth: defaults.cloud_session.token, 
                                                                    isPrivate : true });
                    publishEventPr.then(
                      function(data) {
                          console.log('Dimmed LED for ' + defaults.printers[i].coreid + ' to ' + defaults.button_settings.bright_led);
                      },
                      function(err) {
                        console.log("Failed to publish event: " + err)
                      }
                    );                
                } 
            } else 
                console.log("No connection to cloud, not adjusting LED brightness."); 
        });

        particle.login({username: defaults.cloud_session.user, password: defaults.cloud_session.pass}).then(
            function(data) {
                defaults.cloud_session.token = data.body.access_token;
                console.log('Main session created as user ', defaults.cloud_session.user);
                cloud_connected = true;
                
                //Get all events
                particle.getEventStream({ deviceId: 'mine',auth: defaults.cloud_session.token}).then(function(stream) {
                  stream.on('event', function(data) {
                      if ((data.name == 'spark/status') && (data.data = 'online')) {
                        // Photon came online - will need an update message !
                        // {"data":"online","ttl":60,"published_at":"2017-12-01T16:38:52.783Z","coreid":"42001f001051363036373538","name":"spark/status"}
                        var sender    = data.coreid;  
                        for (var i = 0; i < defaults.printers.length; i++) {
                            if (sender == defaults.printers[i].coreid) {
                                printer = defaults.printers[i].bootup = true;
                                console.log("Photon bootup: " + defaults.printers[i].name);
                            }
                        }
                        
                      } else if (data.name == 'Octoprint_state_request') {
                        var tgt_state = data.data;
                        var sender    = data.coreid;  
                        var printer   = {};
                        
                        // -- ToDo: Map the core-ID to the respective printer, make Octoprint connection details dynamic!
                        for (var i = 0; i < defaults.printers.length; i++) {
                            if (sender == defaults.printers[i].coreid) {
                                printer = defaults.printers[i];
                                console.log("Received Message is from " + printer.name);
                            }
                        }
                        
                        console.log("Event: ", data);
                        switch (tgt_state) {
                            case "1": // - "Online" = connect to Printer
                                PostCommand('/api/connection',{ "command": "connect" },printer);
                                break;
                            case "2": // - "Printing" = continue paused Print
                                PostCommand('/api/job',{ "command": "pause", "action" : "resume" },printer);
                                break;
                            case "3": // - "Paused" = pause current Print job
                                PostCommand('/api/job',{ "command": "pause", "action" : "pause" },printer);
                                break;
                            case "5": // - "Offline" = disconnect Printer
                                PostCommand('/api/connection',{ "command": "disconnect" },printer);
                                break;
                            case "6": // - Stop current Print job
                                PostCommand('/api/job',{ "command": "cancel" },printer);
                                break;
                            case "7": // - Restart current Print job
                                PostCommand('/api/job',{ "command": "restart" },printer);
                                break;
                            default:
                                console.warn("Unhandled State Request:" + tgt_state);
                        }
                      }
                  });
                });        
                
            },
            function(err) {
                console.log('Main Session creation FAILED for ', defaults.cloud_session.user ,":\n", err);
            }
        );        
        
    } else {
        console.error("unable to read configuration !");
        process.exit(1);
    }
});

function createSock(printer) {
    printer.last_high_temp = 0;
    printer.sock    = new SockJS(printer.url + '/sockjs');
    
    printer.sock.onopen = function() {
        console.log(printer.name + ': Sock open');
        printer.sock.printer = printer; // -- will be used to re-connect in case of a RPI downtime, could also set 
        //printer.sock.send({"throttle" : 6});
    };
    printer.sock.onmessage = function(e) {
        //console.log('message', e.data);
        /*     
        { current:
           { logs: [ 'Send: N2487 M105*30' ],
             offsets: {},
             serverTime: 1498835747.971358,
             busyFiles: [],
             messages: [],
             job:
              { file: [Object],
                estimatedPrintTime: null,
                averagePrintTime: null,
                filament: null,
                lastPrintTime: null },
             temps: [],
             state: { text: 'Operational', flags: [Object] },
             currentZ: null,
             progress:
              { completion: null,
                printTimeLeft: null,
                printTime: null,
                filepos: null } } }     
         */
         
         if (e.data.hasOwnProperty('current')) {
             var state = e.data.current.state.text;
             //console.log(printer.name + " state:" + state);

             /* Temperatures, not send all the time !
             [ { tool0: { actual: 237.45, target: 238 },
                bed: { actual: 59.88, target: 60 },
                tool1: { actual: 36.51, target: 0 },
                time: 1498836860 } ]
             */
             
             // -- Temperatures, not send all the time, hence we'll store the last value we see.
             if (e.data.current.temps[0]) {
                //console.log(e.data.current.temps[0]);
                if (e.data.current.temps[0].hasOwnProperty('tool0')) {
                    // console.log(printer.name + " tool0 temp :" + e.data.current.temps[0].tool0.actual);
                    printer.last_high_temp = Math.round(e.data.current.temps[0].tool0.actual);
                }
                if (e.data.current.temps[0].hasOwnProperty('tool1') && (printer.last_high_temp < e.data.current.temps[0].tool1.actual)) {
                    // console.log(printer.name + " tool1 temp :" + e.data.current.temps[0].tool1.actual);
                    printer.last_high_temp = Math.round(e.data.current.temps[0].tool1.actual);
                }
                if (e.data.current.temps[0].hasOwnProperty('bed') && (printer.last_high_temp < e.data.current.temps[0].bed.actual)) {
                    // console.log(printer.name + " bed temp :" + e.data.current.temps[0].bed.actual);
                    printer.last_high_temp = Math.round(e.data.current.temps[0].bed.actual);
                }
                console.log(printer.name + " highest temp :" + printer.last_high_temp);
             } 
                              
             // -- send state and completion to particle.
             switch (state) {
                case "Operational":
                    state_code = 1;
                    break;
                case "Printing":
                    var pct   = Math.round(e.data.current.progress.completion);
                    //console.log(printer.name + " completion:"+ pct);
                    state_code = 2;
                    break;
                case "Paused":
                    var pct   = Math.round(e.data.current.progress.completion);
                    //console.log(printer.name + " Completion (paused):"+ pct);
                    state_code = 3;
                    break;
                case "Error":
                    //console.log(printer.name +  " Printer in Error state");
                    state_code = 4;
                    break;
                case "Offline":
                    //console.log(printer.name + " Printer in Offline state");
                    state_code = 5;
                    break;
                default:
                    console.log(printer.name + " unhandled state:" + state);
                    state_code = 6;
                    console.log(e.data);
             }

             var hot = (printer.last_high_temp >= 60) ? 1 : 0;
             
             if (printer.bootup || (printer.lastState != state) || (printer.last_pct  != pct) || (printer.hot  != hot)) {
                 console.log(printer.name + " had a change. State:"+ state + " pct:" + pct);

                if (cloud_connected) {
                    // -- only re-set the send-trigger here. The cloud would not get updated if it is reset without connection!
                    printer.lastState = state;
                    printer.last_pct  = pct;
                    printer.bootup    = false;
                    printer.hot       = hot;

                    var hot = (printer.last_high_temp >= 60) ? 1 : 0;
                    var msg = state_code + "|" + pct + "|" + printer.hot + "|" + printer.coreid;
                    console.log(msg);
                    var publishEventPr = particle.publishEvent({    name: printer.event, 
                                                                    data: msg, 
                                                                    auth: defaults.cloud_session.token, 
                                                                    isPrivate : true });
                    publishEventPr.then(
                      function(data) {
                        //if (data.body.ok) { console.log("Event published succesfully") }
                      },
                      function(err) {
                        console.log("Failed to publish event: " + err)
                      }
                    );
                 } else 
                     console.warn("No cloud connection - not posting!");
             }             
         } else if (e.data.hasOwnProperty('connected')) {
             console.log("(useless) API Key:" + e.data.connected.apikey);
         }
    };
    printer.sock.onclose = function() {
         console.log('close');
    };
}
 
function PostCommand(path,cmd,printer) {
    // An object of options to indicate where to post to
    console.log("Sending command to Octoprint:" + path);"Sending command to Octoprint:" + path + " :" + 
    console.log(cmd);
  
    http.post({
        url: printer.url + path,
        reqBody: Buffer.from(JSON.stringify(cmd)),
        headers: {
            // specify how to handle the request, http-request makes no assumptions
            'X-Api-Key' : printer.api,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(JSON.stringify(cmd))
        }
    }, null, function (err, res) {
        if (err) {
            console.error(err);
            return;
        }
        console.log(res.code, res.headers, res.file);
    });  
    return;
    
}
 