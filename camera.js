// camera.js - Camera streaming support for SFR Home
const { StreamRequestTypes, SRTPCryptoSuites } = require('@homebridge/camera-utils').hap;
const ip = require('ip');

class SFRHomeCamera {
  constructor(platform, accessory) {
    this.platform = platform;
    this.log = platform.log;
    this.api = platform.api;
    this.hap = platform.api.hap;
    this.accessory = accessory;
    
    this.streamUrl = accessory.context.streamUrl;
    this.mac = accessory.context.cameraMac;
    
    this.services = [];
    this.streamControllers = new Map();
    
    this.pendingSessions = new Map();
    
    this.createCameraControlService();
    this._createStreamControllers(2);
  }
  
  createCameraControlService() {
    const service = this.accessory.getService(this.hap.Service.CameraControl) || 
                    this.accessory.addService(this.hap.Service.CameraControl);
    this.services.push(service);
  }
  
  _createStreamControllers(maxStreams) {
    for (let i = 0; i < maxStreams; i++) {
      const options = {
        proxy: false,
        disableAudioProxy: true,
        srtp: true,
        video: {
          resolutions: [
            [1920, 1080, 30],
            [1280, 720, 30],
            [640, 360, 15],
            [320, 240, 15]
          ],
          codec: {
            profiles: [0, 1, 2],
            levels: [0, 1, 2]
          }
        },
        audio: {
          codecs: [
            {
              type: 'AAC-eld',
              samplerate: 16
            }
          ]
        }
      };
      
      const controller = new this.hap.StreamController(i, options, this);
      this.accessory.configureController(controller);
      this.streamControllers.set(i, controller);
      this.services.push(controller.service);
    }
  }
  
  handleSnapshotRequest(request, callback) {
    this.log.debug('[Camera ' + this.accessory.displayName + '] Snapshot request');
    // Try to get snapshot from SFR
    const axios = require('axios');
    const snapshotUrl = 'https://home.sfr.fr/homescope/snapshot?mac=' + this.mac + '';
    
    this.platform.auth.makeRequest(snapshotUrl, {
      responseType: 'arraybuffer',
      headers: { Referer: 'https://home.sfr.fr/accueil' },
      validateStatus: () => true
    }).then(resp => {
      if (resp.status === 200 && resp.data) {
        callback(null, Buffer.from(resp.data));
      } else {
        callback(new Error('Failed to get snapshot'));
      }
    }).catch(err => {
      this.log.error('[Camera ' + this.accessory.displayName + '] Snapshot error: ${err.message}');
      callback(err);
    });
  }
  
  prepareStream(request, callback) {
    const sessionInfo = {
      address: request.targetAddress,
      video: {
        port: request.video.port,
        srtpCryptoSuite: request.video.srtpCryptoSuite,
        srtp_key: request.video.srtp_key,
        srtp_salt: request.video.srtp_salt
      },
      audio: {
        port: request.audio.port,
        srtpCryptoSuite: request.audio.srtpCryptoSuite,
        srtp_key: request.audio.srtp_key,
        srtp_salt: request.audio.srtp_salt
      }
    };
    
    const response = {
      address: {
        address: ip.address('public') || ip.address(),
        type: request.addressVersion
      },
      video: {
        port: sessionInfo.video.port,
        ssrc: this._generateSsrc(),
        srtp_key: sessionInfo.video.srtp_key,
        srtp_salt: sessionInfo.video.srtp_salt,
        srtpCryptoSuite: sessionInfo.video.srtpCryptoSuite
      },
      audio: {
        port: sessionInfo.audio.port,
        ssrc: this._generateSsrc(),
        srtp_key: sessionInfo.audio.srtp_key,
        srtp_salt: sessionInfo.audio.srtp_salt,
        srtpCryptoSuite: sessionInfo.audio.srtpCryptoSuite
      }
    };
    
    this.pendingSessions.set(request.sessionID, sessionInfo);
    callback(null, response);
  }
  
  handleStreamRequest(request) {
    if (request.type === StreamRequestTypes.START) {
      const sessionInfo = this.pendingSessions.get(request.sessionID);
      if (!sessionInfo) {
        return;
      }
      
      this.log.info('[Camera ' + this.accessory.displayName + '] Starting stream from ${this.streamUrl}');
      
      const ffmpegArgs = [
        '-i', this.streamUrl,
        '-f', 'mpegts',
        '-codec:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-max_delay', '500000',
        '-pix_fmt', 'yuv420p',
        '-r', '30',
        '-g', '60',
        '-sc_threshold', '0',
        '-s', '' + request.video.width + 'x${request.video.height}',
        '-b:v', '' + request.video.max_bit_rate + 'k',
        '-bufsize', '' + request.video.max_bit_rate * 2 + 'k',
        '-maxrate', '' + request.video.max_bit_rate + 'k',
        '-f', 'rtp',
        '-sdp_file', '/tmp/' + request.sessionID + '.sdp',
        'rtp://' + sessionInfo.address + ':' + request.video.port + '?rtcpport=' + request.video.port + '&localrtcpport=' + request.video.port + '&pkt_size=1316'
      ];
      
      const { spawn } = require('child_process');
      const ffmpeg = spawn('ffmpeg', ffmpegArgs, { env: process.env });
      
      this.pendingSessions.set(request.sessionID, { ...sessionInfo, ffmpeg });
      
      ffmpeg.stderr.on('data', (data) => {
        this.log.debug('[Camera ' + this.accessory.displayName + '] ffmpeg: ' + data.toString());
      });
      
      ffmpeg.on('error', (err) => {
        this.log.error('[Camera ' + this.accessory.displayName + '] ffmpeg error: ${err.message}');
      });
      
      ffmpeg.on('close', (code) => {
        this.log.debug('[Camera ' + this.accessory.displayName + '] ffmpeg closed with code ${code}');
      });
      
    } else if (request.type === StreamRequestTypes.STOP) {
      const sessionInfo = this.pendingSessions.get(request.sessionID);
      if (sessionInfo && sessionInfo.ffmpeg) {
        try {
          sessionInfo.ffmpeg.kill('SIGKILL');
        } catch (e) {}
      }
      this.pendingSessions.delete(request.sessionID);
      this.log.info('[Camera ' + this.accessory.displayName + '] Stopping stream');
    }
  }
  
  _generateSsrc() {
    return Math.floor(Math.random() * 0xFFFFFFFF);
  }
}

module.exports = SFRHomeCamera;
