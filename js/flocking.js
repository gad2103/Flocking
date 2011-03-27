"use strict";

var flock = flock || {};

(function () {
    
    flock.OUT_UGEN_ID = "flocking-out";
    
    flock.rates = {
        AUDIO: "audio",
        CONSTANT: "constant"
    };
    
    flock.defaults = {
        sampleRate: 44100,
        controlRate: 64,
        bufferSize: 22050,
        minLatency: 250,
        writeInterval: 100
    };
    
    /*************
     * Utilities *
     *************/
    
     flock.minBufferSize = function (sampleRate, chans, latency) {
         return (sampleRate * chans) / (1000 / latency);
     };
     
    flock.constantBuffer = function (val, size) {
        var buf = new Float32Array(size);
        for (var i = 0; i < size; i++) {
            buf[i] = val;
        }
        return buf;
    };
    
    flock.mul = function (mulWire, output, numSamps) {
        var mul = mulWire.pull(numSamps);
        for (var i = 0; i < numSamps; i++) {
            output[i] = output[i] * mul[i];
        }
        return output;
    };
    
    flock.add = function (addWire, output, numSamps) {
        var add = addWire.pull(numSamps);
        for (var i = 0; i < numSamps; i++) {
            output[i] = output[i] + add[i];
        }
        
        return output;
    };
    
    flock.mulAdd = function (mulWire, addWire, output, numSamps) {
        var mul = mulWire.pull(numSamps);
        var add = addWire.pull(numSamps);
        for (var i = 0; i < numSamps; i++) {
            output[i] = output[i] * mul[i] + add[i];
        }
        return output;
    };
    
    flock.pathParseError = function (path, token) {
        throw new Error("Error parsing path: " + path + ". Segment '" + token + 
            "' could not be resolved.");
    };
    
    flock.resolvePath = function (path, root) {
        var tokenized = path === "" ? [] : String(path).split(".");
        root = root || window;
        var valForSeg = root[tokenized[0]];
        
        for (var i = 1; i < tokenized.length; i++) {
            if (valForSeg === null || valForSeg === undefined) {
                flock.pathParseError(path, tokenized[i - 1]);
            }
            valForSeg = valForSeg[tokenized[i]];
        }
        return valForSeg;
    };
    
    flock.invokePath = function (path, args, root) {
        var fn = flock.resolvePath(path, root);
        if (typeof(fn) !== "function") {
            throw new Error("Path '" + path + "' does not resolve to a function.");
        }
        return fn.apply(null, args);
    };
    
    
    /*******************
     * Unit Generators *
     *******************/
    // TODO:
    //  - Add support for control-rate signals. This will require double buffering and calling pull() much more often.
    //     (i.e. calling pull() at the control rate)
    //  - Can wires be tossed altogether?
    
    flock.wire = function (source, sampleRate) {
        var that = {
            source: typeof (source) === "number" ? 
                flock.ugen.value({value: source}, null, sampleRate) : source
        };
        that.pull = that.source[that.source.rate];
        
        return that;
    };
    
    flock.ugen = function (inputs, output, sampleRate) {
        var that = {
            inputs: inputs,
            output: output,
            sampleRate: sampleRate || flock.defaults.sampleRate,
            rate: flock.rates.AUDIO,
            model: {}
        };
        
        return that;
    };
    
    flock.ugen.mulAdder = function (that) {
        // Reads directly from the output buffer, overwriting it in place with modified values.
        that.mulAdd = function (numSamps) {            
            // If we have no mul or add inputs, bail immediately.
            if (!that.inputs.mul && !that.inputs.add) {
                return that.output;
            }
            
            // Only add.
            if (!that.inputs.mul) {
                return flock.add(that.inputs.add, that.output, numSamps);
            }
            
            // Only mul.
            if (!that.inputs.add) {
                return flock.mul(that.inputs.mul, that.output, numSamps);
            }
            
            // Both mul and add.
            return flock.mulAdd(that.inputs.mul, that.inputs.add, that.output, numSamps);
        };
        
        return that;
    };
    
    flock.ugen.value = function (inputs, output, sampleRate) {
        var that = flock.ugen(inputs, output, sampleRate);
        that.model.value = inputs.value;
        that.buffer = flock.constantBuffer(that.model.value, that.sampleRate);
        
        that.audio = function (numSamps) {
            var len = that.sampleRate;
            if (numSamps < len) {
                return that.buffer.subarray(0, numSamps);
            } else if (numSamps === len) {
                return that.buffer;
            } else {
                that.buffer = new Float32Array(numSamps);
                return that.buffer;
            }
        };
        
        return that;
    };
    
    flock.ugen.sinOsc = function (inputs, output, sampleRate) {
        var that = flock.ugen(inputs, output, sampleRate);
        flock.ugen.mulAdder(that);
        that.wavetable = flock.ugen.sinOsc.generateWavetable(that.sampleRate);
        that.model.phase = 0;
        
        // Scan the wavetable at the given frequency to generate the output.
        that.audio = function (numSamps) {
            // Cache instance variables locally so we don't pay the cost of property lookup
            // within the sample generation loop.
            var freq = that.inputs.freq.pull(numSamps),
                tableLen = that.wavetable.length,
                output = that.output,
                wavetable = that.wavetable,
                phase = that.model.phase,
                sampleRate = that.sampleRate;

            for (var i = 0; i < numSamps; i++) {
                output[i] = wavetable[phase];
                var increment = freq[i] * tableLen / sampleRate;
                phase += increment;
                if (phase > tableLen) {
                    phase -= tableLen;
                }
                that.model.phase = phase;
            }
            
            return that.mulAdd(numSamps);
        };
        
        return that;
    };
    
    flock.ugen.sinOsc.generateWavetable = function (sampleRate) {
        var scale = (2.0 * Math.PI) / sampleRate;
        var wavetable = new Float32Array(sampleRate);
        for (var i = 0; i < sampleRate; i++) {
            wavetable[i] = Math.sin(i * scale);
        }
        return wavetable;
    };
    
    flock.ugen.dust = function (inputs, output, sampleRate) {
        var that = flock.ugen(inputs, output, sampleRate);
        flock.ugen.mulAdder(that);
        that.model = {
            density: 0.0,
            scale: 0.0,
            threshold: 0.0,
            sampleDur: 1.0 / that.sampleRate
        };
        
        that.audio = function (numSamps) {
            var density = inputs.density.pull(numSamps)[0], // Assume density is control rate.
                threshold, scale;
                
            if (density !== that.model.density) {
                that.model.density = density;
                threshold = that.model.threshold = density * that.model.sampleDur;
                scale = that.model.scale = threshold > 0.0 ? 1.0 / threshold : 0.0;
            } else {
                threshold = that.model.threshold;
                scale = that.model.scale;
            }
            
            for (var i = 0; i < numSamps; i++) {
                var rand = Math.random();
                output[i] = (rand < threshold) ? rand * scale : 0.0;
            }
            
            return that.mulAdd(numSamps);
        };

        return that;
    };
    
    flock.ugen.out = function (inputs, output, sampleRate) {
        var that = flock.ugen(inputs, output, sampleRate);
        
        that.audio = function (numFrames, offset) {
            var sourceBuf = that.inputs.source.pull(numFrames);
            var output = that.output;
            
            // Handle multiple channels, including stereo expansion of a single channel.
            var left, right;
            if (sourceBuf.length === 2) {
                // Assume we've got a stereo pair of output buffers
                left = sourceBuf[0];
                right = sourceBuf[1];
            } else {
                left = sourceBuf;
                right = sourceBuf; 
            }

            // Interleave each output channel into stereo frames.
            offset = offset || 0;
            for (var i = 0 || 0; i < numFrames; i++) {
                var frameIdx = i * 2 + offset;
                output[frameIdx] = left[i];
                output[frameIdx + 1] = right[i];
            }
            
            return output;
        };
        
        return that;
    };
    
    
    /**********
     * Synths *
     **********/
    
    var writeControlRateAudio = function (outUGen, audioEl, preBufferSize, chans, playState) {
        var currSamp = audioEl.mozCurrentSampleOffset();
        var needed = currSamp + preBufferSize - playState.written;
        var kr = flock.defaults.controlRate;
        var numKRBuffers = Math.round(needed / kr);
        var bufSize = numKRBuffers * kr * chans;
        var outBuf = new Float32Array(bufSize);
        outUGen.output = outBuf;
        for (var i = 0; i < numKRBuffers; i++) {
            outUGen.audio(kr, i * kr * chans);
        }
        var written = audioEl.mozWriteAudio(outBuf);
        playState.written = playState.written + written;  
    };
    
    var writeAudio = function (outUGen, audioEl, preBufferSize, chans, playState) {
        var needed = audioEl.mozCurrentSampleOffset() + preBufferSize - playState.written;
        var outBuf = new Float32Array(needed * chans);
        outUGen.output = outBuf;
        outUGen.audio(needed);
        playState.written += audioEl.mozWriteAudio(outBuf);
    };
    
    flock.synth = function (graphDef, options) {
        // TODO: Consolidate options and model.
        options = options || {};
        var that = {
            audioEl: new Audio(),
            sampleRate: options.sampleRate || flock.defaults.sampleRate,
            chans: 2, // TODO: Hardbaked to stereo. Add support for more and less channels.
            bufferSize: options.bufferSize || flock.defaults.bufferSize,
            writeInterval: options.writeInterval || flock.defaults.writeInterval,
            playbackTimerId: null,
            playState: {
                written: 0,
                total: null
            },
            model: graphDef
        };
        that.preBufferSize = flock.minBufferSize(that.sampleRate, that.chans, flock.defaults.minLatency);
        that.ugens = flock.parse.graph(that.model, that.sampleRate, that.bufferSize);
        that.out = that.ugens[flock.OUT_UGEN_ID];
        that.audioEl.mozSetup(that.chans, that.sampleRate);
        
        that.play = function (duration) {
            that.playState.total = (duration === undefined) ? Infinity : 
                duration * (that.sampleRate * that.numChans);

            that.playbackTimerId = window.setInterval(function () {
                writeAudio(that.out, that.audioEl, that.preBufferSize, that.chans, that.playState);
                if (that.playState.written >= that.playState.total) {
                    that.stop();
                }
            }, that.writeInterval);
        };
        
        that.stop = function () {
            window.clearInterval(that.playbackTimerId);
        };
    
        // TODO:
        //  - Awkward stuff! 
        //  - Replace with a proxy?
        that.input = function (path, val) {
            // TODO: Hard-coded to two-segment paths.
            var tokenized = path.split("."),
                ugenId = tokenized[0],
                input = tokenized[1];
                
            var ugen = that.ugens[ugenId];
            if (!ugen) {
                flock.pathParseError(path, ugenId);
            }

            // Get.
            if (arguments.length < 2) {
                if (!input) {
                    return ugen;
                }
                
                if (!ugen.inputs[input]) {
                    flock.pathParseError(path, input);
                }
                var inputSource = ugen.inputs[input].source;
                return inputSource.model.value !== undefined ? inputSource.model.value : inputSource;
            }
                
            // Set.
            if (!input) {
                throw new Error("Setting a ugen directly is not currently supported.");
            }
            return ugen.inputs[input] = flock.wire(val, that.sampleRate);
        };
              
        return that;
    };
    

    
    /**********
     * Parser *
     **********/
    // TODO:
    //  - Remove the need to specify the output ugen
    //  - Support multiple channels.
    
    flock.parse = flock.parse || {};
    
    flock.parse.graph = function (ugenDef, sampleRate, bufferSize) {
        var ugens = {};
        var root = flock.parse.ugenForDef(ugenDef, sampleRate, bufferSize, ugens);
        ugens[flock.OUT_UGEN_ID] = root;
        return ugens;
    };
    
     // TODO: 
     //  - parse ugens into an id-keyed hash so that they can be accessed directly if needed
     //  - create "input tokens" in definition format to expose variables to a synth
    flock.parse.ugenForDef = function (ugenDef, sampleRate, bufferSize, ugens) {
        var inputDefs = ugenDef.inputs;
        var inWires = {};
        for (var inputDef in inputDefs) {
            // Wire all inputs except value inputs.
            inWires[inputDef] = inputDef === "value" ? ugenDef.inputs[inputDef] :
                flock.parse.wireForInputDef(ugenDef.inputs[inputDef], sampleRate, bufferSize, ugens);
        }
        
        if (!ugenDef.ugen) {
            throw new Error("Unit generator definition lacks a 'ugen' property; can't initialize the synth graph.");
        }
        
        return flock.invokePath(ugenDef.ugen, [inWires, new Float32Array(bufferSize), sampleRate]);
    };
    
    flock.parse.expandInputDef = function (inputDef) {
        switch (typeof (inputDef)) {
            case "number":
                return {
                    ugen: "flock.ugen.value",
                    inputs: {
                        value: inputDef
                    }
                };
            case "object":
                return inputDef;
            default:
                throw new Error("Invalid value type found in ugen definition.");
        }
    };
    
    flock.parse.wireForInputDef = function (inputDef, sampleRate, bufferSize, ugens) {    
        inputDef = flock.parse.expandInputDef(inputDef);
        var ugen = flock.parse.ugenForDef(inputDef, sampleRate, bufferSize, ugens);
        if (inputDef.id) {
            ugens[inputDef.id] = ugen;
        }
        return flock.wire(ugen, sampleRate);
    };

})();
