***

title: Streaming
subtitle: >-
Learn how to stream real-time audio from the ElevenLabs API using chunked
transfer encoding
-----------------

The ElevenLabs API supports real-time audio streaming for select endpoints, returning raw audio bytes (e.g., MP3 data) directly over HTTP using chunked transfer encoding. This allows clients to process or play audio incrementally as it is generated.

Our official [Node](https://github.com/elevenlabs/elevenlabs-js) and [Python](https://github.com/elevenlabs/elevenlabs-python) libraries include utilities to simplify handling this continuous audio stream.

Streaming is supported for the [Text to Speech API](/docs/api-reference/text-to-speech/stream), [Voice Changer API](/docs/api-reference/speech-to-speech/stream) & [Audio Isolation API](/docs/api-reference/audio-isolation/stream). This section focuses on how streaming works for requests made to the Text to Speech API.

In Python, a streaming request looks like:

```python
from elevenlabs import stream
from elevenlabs.client import ElevenLabs

elevenlabs = ElevenLabs()

audio_stream = elevenlabs.text_to_speech.stream(
    text="This is a test",
    voice_id="JBFqnCBsd6RMkjVDRZzb",
    model_id="eleven_multilingual_v2"
)

# option 1: play the streamed audio locally
stream(audio_stream)

# option 2: process the audio bytes manually
for chunk in audio_stream:
    if isinstance(chunk, bytes):
        print(chunk)
```

In Node / Typescript, a streaming request looks like:

```javascript maxLines=0
import { ElevenLabsClient, stream } from '@elevenlabs/elevenlabs-js';
import { Readable } from 'stream';

const elevenlabs = new ElevenLabsClient();

async function main() {
  const audioStream = await elevenlabs.textToSpeech.stream('JBFqnCBsd6RMkjVDRZzb', {
    text: 'This is a test',
    modelId: 'eleven_multilingual_v2',
  });

  // option 1: play the streamed audio locally
  await stream(Readable.from(audioStream));

  // option 2: process the audio manually
  for await (const chunk of audioStream) {
    console.log(chunk);
  }
}

main();
```

# Stream speech

POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream
Content-Type: application/json

Converts text into speech using a voice of your choice and returns audio as an audio stream.

Reference: https://elevenlabs.io/docs/api-reference/text-to-speech/stream

## OpenAPI Specification

```yaml
openapi: 3.1.0
info:
  title: api
  version: 1.0.0
paths:
  /v1/text-to-speech/{voice_id}/stream:
    post:
      operationId: stream
      summary: Stream speech
      description: >-
        Converts text into speech using a voice of your choice and returns audio
        as an audio stream.
      tags:
        - subpackage_textToSpeech
      parameters:
        - name: voice_id
          in: path
          description: >-
            ID of the voice to be used. Use the [Get
            voices](/docs/api-reference/voices/search) endpoint list all the
            available voices.
          required: true
          schema:
            type: string
        - name: enable_logging
          in: query
          description: >-
            When enable_logging is set to false zero retention mode will be used
            for the request. This will mean history features are unavailable for
            this request, including request stitching. Zero retention mode may
            only be used by enterprise customers.
          required: false
          schema:
            type: boolean
            default: true
        - name: optimize_streaming_latency
          in: query
          description: >-
            You can turn on latency optimizations at some cost of quality. The
            best possible final latency varies by model. Possible values:

            0 - default mode (no latency optimizations)

            1 - normal latency optimizations (about 50% of possible latency
            improvement of option 3)

            2 - strong latency optimizations (about 75% of possible latency
            improvement of option 3)

            3 - max latency optimizations

            4 - max latency optimizations, but also with text normalizer turned
            off for even more latency savings (best latency, but can
            mispronounce eg numbers and dates).


            Defaults to None.
          required: false
          schema:
            type: integer
        - name: output_format
          in: query
          description: >-
            Output format of the generated audio. Formatted as
            codec_sample_rate_bitrate. So an mp3 with 22.05kHz sample rate at
            32kbs is represented as mp3_22050_32. MP3 with 192kbps bitrate
            requires you to be subscribed to Creator tier or above. PCM with
            44.1kHz sample rate requires you to be subscribed to Pro tier or
            above. Note that the μ-law format (sometimes written mu-law, often
            approximated as u-law) is commonly used for Twilio audio inputs.
          required: false
          schema:
            $ref: >-
              #/components/schemas/type_textToSpeech:TextToSpeechStreamRequestOutputFormat
        - name: xi-api-key
          in: header
          required: false
          schema:
            type: string
      responses:
        '200':
          description: Streaming audio data
          content:
            application/octet-stream:
              schema:
                type: string
                format: binary
        '422':
          description: Validation Error
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/type_:HTTPValidationError'
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                text:
                  type: string
                  description: The text that will get converted into speech.
                model_id:
                  type: string
                  default: eleven_multilingual_v2
                  description: >-
                    Identifier of the model that will be used, you can query
                    them using GET /v1/models. The model needs to have support
                    for text to speech, you can check this using the
                    can_do_text_to_speech property.
                language_code:
                  type: string
                  description: >-
                    Language code (ISO 639-1) used to enforce a language for the
                    model and text normalization. If the model does not support
                    provided language code, an error will be returned.
                voice_settings:
                  $ref: '#/components/schemas/type_:VoiceSettings'
                  description: >-
                    Voice settings overriding stored settings for the given
                    voice. They are applied only on the given request.
                pronunciation_dictionary_locators:
                  type: array
                  items:
                    $ref: >-
                      #/components/schemas/type_:PronunciationDictionaryVersionLocator
                  description: >-
                    A list of pronunciation dictionary locators (id, version_id)
                    to be applied to the text. They will be applied in order.
                    You may have up to 3 locators per request
                seed:
                  type: integer
                  description: >-
                    If specified, our system will make a best effort to sample
                    deterministically, such that repeated requests with the same
                    seed and parameters should return the same result.
                    Determinism is not guaranteed. Must be integer between 0 and
                    4294967295.
                previous_text:
                  type: string
                  description: >-
                    The text that came before the text of the current request.
                    Can be used to improve the speech's continuity when
                    concatenating together multiple generations or to influence
                    the speech's continuity in the current generation.
                next_text:
                  type: string
                  description: >-
                    The text that comes after the text of the current request.
                    Can be used to improve the speech's continuity when
                    concatenating together multiple generations or to influence
                    the speech's continuity in the current generation.
                previous_request_ids:
                  type: array
                  items:
                    type: string
                  description: >-
                    A list of request_id of the samples that were generated
                    before this generation. Can be used to improve the speech's
                    continuity when splitting up a large task into multiple
                    requests. The results will be best when the same model is
                    used across the generations. In case both previous_text and
                    previous_request_ids is send, previous_text will be ignored.
                    A maximum of 3 request_ids can be send.
                next_request_ids:
                  type: array
                  items:
                    type: string
                  description: >-
                    A list of request_id of the samples that come after this
                    generation. next_request_ids is especially useful for
                    maintaining the speech's continuity when regenerating a
                    sample that has had some audio quality issues. For example,
                    if you have generated 3 speech clips, and you want to
                    improve clip 2, passing the request id of clip 3 as a
                    next_request_id (and that of clip 1 as a
                    previous_request_id) will help maintain natural flow in the
                    combined speech. The results will be best when the same
                    model is used across the generations. In case both next_text
                    and next_request_ids is send, next_text will be ignored. A
                    maximum of 3 request_ids can be send.
                use_pvc_as_ivc:
                  type: boolean
                  default: false
                  description: >-
                    If true, we won't use PVC version of the voice for the
                    generation but the IVC version. This is a temporary
                    workaround for higher latency in PVC versions.
                apply_text_normalization:
                  $ref: >-
                    #/components/schemas/type_textToSpeech:BodyTextToSpeechStreamApplyTextNormalization
                  description: >-
                    This parameter controls text normalization with three modes:
                    'auto', 'on', and 'off'. When set to 'auto', the system will
                    automatically decide whether to apply text normalization
                    (e.g., spelling out numbers). With 'on', text normalization
                    will always be applied, while with 'off', it will be
                    skipped.
                apply_language_text_normalization:
                  type: boolean
                  default: false
                  description: >-
                    This parameter controls language text normalization. This
                    helps with proper pronunciation of text in some supported
                    languages. WARNING: This parameter can heavily increase the
                    latency of the request. Currently only supported for
                    Japanese.
              required:
                - text
servers:
  - url: https://api.elevenlabs.io
  - url: https://api.us.elevenlabs.io
  - url: https://api.eu.residency.elevenlabs.io
  - url: https://api.in.residency.elevenlabs.io
components:
  schemas:
    type_textToSpeech:TextToSpeechStreamRequestOutputFormat:
      type: string
      enum:
        - mp3_22050_32
        - mp3_24000_48
        - mp3_44100_32
        - mp3_44100_64
        - mp3_44100_96
        - mp3_44100_128
        - mp3_44100_192
        - pcm_8000
        - pcm_16000
        - pcm_22050
        - pcm_24000
        - pcm_32000
        - pcm_44100
        - pcm_48000
        - ulaw_8000
        - alaw_8000
        - opus_48000_32
        - opus_48000_64
        - opus_48000_96
        - opus_48000_128
        - opus_48000_192
      default: mp3_44100_128
      description: >-
        Output format of the generated audio. Formatted as
        codec_sample_rate_bitrate. So an mp3 with 22.05kHz sample rate at 32kbs
        is represented as mp3_22050_32. MP3 with 192kbps bitrate requires you to
        be subscribed to Creator tier or above. PCM with 44.1kHz sample rate
        requires you to be subscribed to Pro tier or above. Note that the μ-law
        format (sometimes written mu-law, often approximated as u-law) is
        commonly used for Twilio audio inputs.
      title: TextToSpeechStreamRequestOutputFormat
    type_:VoiceSettings:
      type: object
      properties:
        stability:
          type: number
          format: double
          description: >-
            Determines how stable the voice is and the randomness between each
            generation. Lower values introduce broader emotional range for the
            voice. Higher values can result in a monotonous voice with limited
            emotion.
        use_speaker_boost:
          type: boolean
          description: >-
            This setting boosts the similarity to the original speaker. Using
            this setting requires a slightly higher computational load, which in
            turn increases latency.
        similarity_boost:
          type: number
          format: double
          description: >-
            Determines how closely the AI should adhere to the original voice
            when attempting to replicate it.
        style:
          type: number
          format: double
          description: >-
            Determines the style exaggeration of the voice. This setting
            attempts to amplify the style of the original speaker. It does
            consume additional computational resources and might increase
            latency if set to anything other than 0.
        speed:
          type: number
          format: double
          description: >-
            Adjusts the speed of the voice. A value of 1.0 is the default speed,
            while values less than 1.0 slow down the speech, and values greater
            than 1.0 speed it up.
      title: VoiceSettings
    type_:PronunciationDictionaryVersionLocator:
      type: object
      properties:
        pronunciation_dictionary_id:
          type: string
          description: The ID of the pronunciation dictionary.
        version_id:
          type: string
          description: >-
            The ID of the version of the pronunciation dictionary. If not
            provided, the latest version will be used.
      required:
        - pronunciation_dictionary_id
      title: PronunciationDictionaryVersionLocator
    type_textToSpeech:BodyTextToSpeechStreamApplyTextNormalization:
      type: string
      enum:
        - auto
        - 'on'
        - 'off'
      default: auto
      description: >-
        This parameter controls text normalization with three modes: 'auto',
        'on', and 'off'. When set to 'auto', the system will automatically
        decide whether to apply text normalization (e.g., spelling out numbers).
        With 'on', text normalization will always be applied, while with 'off',
        it will be skipped.
      title: BodyTextToSpeechStreamApplyTextNormalization
    type_:ValidationErrorLocItem:
      oneOf:
        - type: string
        - type: integer
      title: ValidationErrorLocItem
    type_:ValidationError:
      type: object
      properties:
        loc:
          type: array
          items:
            $ref: '#/components/schemas/type_:ValidationErrorLocItem'
        msg:
          type: string
        type:
          type: string
      required:
        - loc
        - msg
        - type
      title: ValidationError
    type_:HTTPValidationError:
      type: object
      properties:
        detail:
          type: array
          items:
            $ref: '#/components/schemas/type_:ValidationError'
      title: HTTPValidationError

```

## SDK Code Examples

```typescript
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

async function main() {
    const client = new ElevenLabsClient();
    await client.textToSpeech.stream("JBFqnCBsd6RMkjVDRZzb", {
        outputFormat: "mp3_44100_128",
        text: "The first move is what sets everything in motion.",
        modelId: "eleven_multilingual_v2",
    });
}
main();

```

```python
from elevenlabs import ElevenLabs

client = ElevenLabs()

client.text_to_speech.stream(
    voice_id="JBFqnCBsd6RMkjVDRZzb",
    output_format="mp3_44100_128",
    text="The first move is what sets everything in motion.",
    model_id="eleven_multilingual_v2",
)

```

```go
package main

import (
	"fmt"
	"strings"
	"net/http"
	"io"
)

func main() {

	url := "https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream?output_format=mp3_44100_128"

	payload := strings.NewReader("{\n  \"text\": \"The first move is what sets everything in motion.\",\n  \"model_id\": \"eleven_multilingual_v2\"\n}")

	req, _ := http.NewRequest("POST", url, payload)

	req.Header.Add("Content-Type", "application/json")

	res, _ := http.DefaultClient.Do(req)

	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)

	fmt.Println(res)
	fmt.Println(string(body))

}
```

```ruby
require 'uri'
require 'net/http'

url = URI("https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream?output_format=mp3_44100_128")

http = Net::HTTP.new(url.host, url.port)
http.use_ssl = true

request = Net::HTTP::Post.new(url)
request["Content-Type"] = 'application/json'
request.body = "{\n  \"text\": \"The first move is what sets everything in motion.\",\n  \"model_id\": \"eleven_multilingual_v2\"\n}"

response = http.request(request)
puts response.read_body
```

```java
import com.mashape.unirest.http.HttpResponse;
import com.mashape.unirest.http.Unirest;

HttpResponse<String> response = Unirest.post("https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream?output_format=mp3_44100_128")
  .header("Content-Type", "application/json")
  .body("{\n  \"text\": \"The first move is what sets everything in motion.\",\n  \"model_id\": \"eleven_multilingual_v2\"\n}")
  .asString();
```

```php
<?php
require_once('vendor/autoload.php');

$client = new \GuzzleHttp\Client();

$response = $client->request('POST', 'https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream?output_format=mp3_44100_128', [
  'body' => '{
  "text": "The first move is what sets everything in motion.",
  "model_id": "eleven_multilingual_v2"
}',
  'headers' => [
    'Content-Type' => 'application/json',
  ],
]);

echo $response->getBody();
```

```csharp
using RestSharp;

var client = new RestClient("https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream?output_format=mp3_44100_128");
var request = new RestRequest(Method.POST);
request.AddHeader("Content-Type", "application/json");
request.AddParameter("application/json", "{\n  \"text\": \"The first move is what sets everything in motion.\",\n  \"model_id\": \"eleven_multilingual_v2\"\n}", ParameterType.RequestBody);
IRestResponse response = client.Execute(request);
```

```swift
import Foundation

let headers = ["Content-Type": "application/json"]
let parameters = [
  "text": "The first move is what sets everything in motion.",
  "model_id": "eleven_multilingual_v2"
] as [String : Any]

let postData = JSONSerialization.data(withJSONObject: parameters, options: [])

let request = NSMutableURLRequest(url: NSURL(string: "https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream?output_format=mp3_44100_128")! as URL,
                                        cachePolicy: .useProtocolCachePolicy,
                                    timeoutInterval: 10.0)
request.httpMethod = "POST"
request.allHTTPHeaderFields = headers
request.httpBody = postData as Data

let session = URLSession.shared
let dataTask = session.dataTask(with: request as URLRequest, completionHandler: { (data, response, error) -> Void in
  if (error != nil) {
    print(error as Any)
  } else {
    let httpResponse = response as? HTTPURLResponse
    print(httpResponse)
  }
})

dataTask.resume()
```

# Stream speech with timing

POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream/with-timestamps
Content-Type: application/json

Converts text into speech using a voice of your choice and returns a stream of JSONs containing audio as a base64 encoded string together with information on when which character was spoken.

Reference: https://elevenlabs.io/docs/api-reference/text-to-speech/stream-with-timestamps

## OpenAPI Specification

```yaml
openapi: 3.1.0
info:
  title: api
  version: 1.0.0
paths:
  /v1/text-to-speech/{voice_id}/stream/with-timestamps:
    post:
      operationId: stream-with-timestamps
      summary: Stream speech with timing
      description: >-
        Converts text into speech using a voice of your choice and returns a
        stream of JSONs containing audio as a base64 encoded string together
        with information on when which character was spoken.
      tags:
        - subpackage_textToSpeech
      parameters:
        - name: voice_id
          in: path
          description: >-
            ID of the voice to be used. Use the [Get
            voices](/docs/api-reference/voices/search) endpoint list all the
            available voices.
          required: true
          schema:
            type: string
        - name: enable_logging
          in: query
          description: >-
            When enable_logging is set to false zero retention mode will be used
            for the request. This will mean history features are unavailable for
            this request, including request stitching. Zero retention mode may
            only be used by enterprise customers.
          required: false
          schema:
            type: boolean
            default: true
        - name: optimize_streaming_latency
          in: query
          description: >-
            You can turn on latency optimizations at some cost of quality. The
            best possible final latency varies by model. Possible values:

            0 - default mode (no latency optimizations)

            1 - normal latency optimizations (about 50% of possible latency
            improvement of option 3)

            2 - strong latency optimizations (about 75% of possible latency
            improvement of option 3)

            3 - max latency optimizations

            4 - max latency optimizations, but also with text normalizer turned
            off for even more latency savings (best latency, but can
            mispronounce eg numbers and dates).


            Defaults to None.
          required: false
          schema:
            type: integer
        - name: output_format
          in: query
          description: >-
            Output format of the generated audio. Formatted as
            codec_sample_rate_bitrate. So an mp3 with 22.05kHz sample rate at
            32kbs is represented as mp3_22050_32. MP3 with 192kbps bitrate
            requires you to be subscribed to Creator tier or above. PCM with
            44.1kHz sample rate requires you to be subscribed to Pro tier or
            above. Note that the μ-law format (sometimes written mu-law, often
            approximated as u-law) is commonly used for Twilio audio inputs.
          required: false
          schema:
            $ref: >-
              #/components/schemas/type_textToSpeech:TextToSpeechStreamWithTimestampsRequestOutputFormat
        - name: xi-api-key
          in: header
          required: false
          schema:
            type: string
      responses:
        '200':
          description: Stream of transcription chunks
          content:
            text/event-stream:
              schema:
                $ref: >-
                  #/components/schemas/type_:StreamingAudioChunkWithTimestampsResponse
        '422':
          description: Validation Error
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/type_:HTTPValidationError'
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                text:
                  type: string
                  description: The text that will get converted into speech.
                model_id:
                  type: string
                  default: eleven_multilingual_v2
                  description: >-
                    Identifier of the model that will be used, you can query
                    them using GET /v1/models. The model needs to have support
                    for text to speech, you can check this using the
                    can_do_text_to_speech property.
                language_code:
                  type: string
                  description: >-
                    Language code (ISO 639-1) used to enforce a language for the
                    model and text normalization. If the model does not support
                    provided language code, an error will be returned.
                voice_settings:
                  $ref: '#/components/schemas/type_:VoiceSettings'
                  description: >-
                    Voice settings overriding stored settings for the given
                    voice. They are applied only on the given request.
                pronunciation_dictionary_locators:
                  type: array
                  items:
                    $ref: >-
                      #/components/schemas/type_:PronunciationDictionaryVersionLocator
                  description: >-
                    A list of pronunciation dictionary locators (id, version_id)
                    to be applied to the text. They will be applied in order.
                    You may have up to 3 locators per request
                seed:
                  type: integer
                  description: >-
                    If specified, our system will make a best effort to sample
                    deterministically, such that repeated requests with the same
                    seed and parameters should return the same result.
                    Determinism is not guaranteed. Must be integer between 0 and
                    4294967295.
                previous_text:
                  type: string
                  description: >-
                    The text that came before the text of the current request.
                    Can be used to improve the speech's continuity when
                    concatenating together multiple generations or to influence
                    the speech's continuity in the current generation.
                next_text:
                  type: string
                  description: >-
                    The text that comes after the text of the current request.
                    Can be used to improve the speech's continuity when
                    concatenating together multiple generations or to influence
                    the speech's continuity in the current generation.
                previous_request_ids:
                  type: array
                  items:
                    type: string
                  description: >-
                    A list of request_id of the samples that were generated
                    before this generation. Can be used to improve the speech's
                    continuity when splitting up a large task into multiple
                    requests. The results will be best when the same model is
                    used across the generations. In case both previous_text and
                    previous_request_ids is send, previous_text will be ignored.
                    A maximum of 3 request_ids can be send.
                next_request_ids:
                  type: array
                  items:
                    type: string
                  description: >-
                    A list of request_id of the samples that come after this
                    generation. next_request_ids is especially useful for
                    maintaining the speech's continuity when regenerating a
                    sample that has had some audio quality issues. For example,
                    if you have generated 3 speech clips, and you want to
                    improve clip 2, passing the request id of clip 3 as a
                    next_request_id (and that of clip 1 as a
                    previous_request_id) will help maintain natural flow in the
                    combined speech. The results will be best when the same
                    model is used across the generations. In case both next_text
                    and next_request_ids is send, next_text will be ignored. A
                    maximum of 3 request_ids can be send.
                use_pvc_as_ivc:
                  type: boolean
                  default: false
                  description: >-
                    If true, we won't use PVC version of the voice for the
                    generation but the IVC version. This is a temporary
                    workaround for higher latency in PVC versions.
                apply_text_normalization:
                  $ref: >-
                    #/components/schemas/type_textToSpeech:BodyTextToSpeechStreamWithTimestampsApplyTextNormalization
                  description: >-
                    This parameter controls text normalization with three modes:
                    'auto', 'on', and 'off'. When set to 'auto', the system will
                    automatically decide whether to apply text normalization
                    (e.g., spelling out numbers). With 'on', text normalization
                    will always be applied, while with 'off', it will be
                    skipped.
                apply_language_text_normalization:
                  type: boolean
                  default: false
                  description: >-
                    This parameter controls language text normalization. This
                    helps with proper pronunciation of text in some supported
                    languages. WARNING: This parameter can heavily increase the
                    latency of the request. Currently only supported for
                    Japanese.
              required:
                - text
servers:
  - url: https://api.elevenlabs.io
  - url: https://api.us.elevenlabs.io
  - url: https://api.eu.residency.elevenlabs.io
  - url: https://api.in.residency.elevenlabs.io
components:
  schemas:
    type_textToSpeech:TextToSpeechStreamWithTimestampsRequestOutputFormat:
      type: string
      enum:
        - mp3_22050_32
        - mp3_24000_48
        - mp3_44100_32
        - mp3_44100_64
        - mp3_44100_96
        - mp3_44100_128
        - mp3_44100_192
        - pcm_8000
        - pcm_16000
        - pcm_22050
        - pcm_24000
        - pcm_32000
        - pcm_44100
        - pcm_48000
        - ulaw_8000
        - alaw_8000
        - opus_48000_32
        - opus_48000_64
        - opus_48000_96
        - opus_48000_128
        - opus_48000_192
      default: mp3_44100_128
      description: >-
        Output format of the generated audio. Formatted as
        codec_sample_rate_bitrate. So an mp3 with 22.05kHz sample rate at 32kbs
        is represented as mp3_22050_32. MP3 with 192kbps bitrate requires you to
        be subscribed to Creator tier or above. PCM with 44.1kHz sample rate
        requires you to be subscribed to Pro tier or above. Note that the μ-law
        format (sometimes written mu-law, often approximated as u-law) is
        commonly used for Twilio audio inputs.
      title: TextToSpeechStreamWithTimestampsRequestOutputFormat
    type_:VoiceSettings:
      type: object
      properties:
        stability:
          type: number
          format: double
          description: >-
            Determines how stable the voice is and the randomness between each
            generation. Lower values introduce broader emotional range for the
            voice. Higher values can result in a monotonous voice with limited
            emotion.
        use_speaker_boost:
          type: boolean
          description: >-
            This setting boosts the similarity to the original speaker. Using
            this setting requires a slightly higher computational load, which in
            turn increases latency.
        similarity_boost:
          type: number
          format: double
          description: >-
            Determines how closely the AI should adhere to the original voice
            when attempting to replicate it.
        style:
          type: number
          format: double
          description: >-
            Determines the style exaggeration of the voice. This setting
            attempts to amplify the style of the original speaker. It does
            consume additional computational resources and might increase
            latency if set to anything other than 0.
        speed:
          type: number
          format: double
          description: >-
            Adjusts the speed of the voice. A value of 1.0 is the default speed,
            while values less than 1.0 slow down the speech, and values greater
            than 1.0 speed it up.
      title: VoiceSettings
    type_:PronunciationDictionaryVersionLocator:
      type: object
      properties:
        pronunciation_dictionary_id:
          type: string
          description: The ID of the pronunciation dictionary.
        version_id:
          type: string
          description: >-
            The ID of the version of the pronunciation dictionary. If not
            provided, the latest version will be used.
      required:
        - pronunciation_dictionary_id
      title: PronunciationDictionaryVersionLocator
    type_textToSpeech:BodyTextToSpeechStreamWithTimestampsApplyTextNormalization:
      type: string
      enum:
        - auto
        - 'on'
        - 'off'
      default: auto
      description: >-
        This parameter controls text normalization with three modes: 'auto',
        'on', and 'off'. When set to 'auto', the system will automatically
        decide whether to apply text normalization (e.g., spelling out numbers).
        With 'on', text normalization will always be applied, while with 'off',
        it will be skipped.
      title: BodyTextToSpeechStreamWithTimestampsApplyTextNormalization
    type_:CharacterAlignmentResponseModel:
      type: object
      properties:
        characters:
          type: array
          items:
            type: string
        character_start_times_seconds:
          type: array
          items:
            type: number
            format: double
        character_end_times_seconds:
          type: array
          items:
            type: number
            format: double
      required:
        - characters
        - character_start_times_seconds
        - character_end_times_seconds
      title: CharacterAlignmentResponseModel
    type_:StreamingAudioChunkWithTimestampsResponse:
      type: object
      properties:
        audio_base64:
          type: string
          description: Base64 encoded audio data
        alignment:
          $ref: '#/components/schemas/type_:CharacterAlignmentResponseModel'
          description: Timestamp information for each character in the original text
        normalized_alignment:
          $ref: '#/components/schemas/type_:CharacterAlignmentResponseModel'
          description: Timestamp information for each character in the normalized text
      required:
        - audio_base64
      title: StreamingAudioChunkWithTimestampsResponse
    type_:ValidationErrorLocItem:
      oneOf:
        - type: string
        - type: integer
      title: ValidationErrorLocItem
    type_:ValidationError:
      type: object
      properties:
        loc:
          type: array
          items:
            $ref: '#/components/schemas/type_:ValidationErrorLocItem'
        msg:
          type: string
        type:
          type: string
      required:
        - loc
        - msg
        - type
      title: ValidationError
    type_:HTTPValidationError:
      type: object
      properties:
        detail:
          type: array
          items:
            $ref: '#/components/schemas/type_:ValidationError'
      title: HTTPValidationError

```

## SDK Code Examples

```typescript
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

async function main() {
    const client = new ElevenLabsClient();
    await client.textToSpeech.streamWithTimestamps("JBFqnCBsd6RMkjVDRZzb", {
        outputFormat: "mp3_44100_128",
        text: "The first move is what sets everything in motion.",
        modelId: "eleven_multilingual_v2",
    });
}
main();

```

```python
from elevenlabs import ElevenLabs

client = ElevenLabs()

client.text_to_speech.stream_with_timestamps(
    voice_id="JBFqnCBsd6RMkjVDRZzb",
    output_format="mp3_44100_128",
    text="The first move is what sets everything in motion.",
    model_id="eleven_multilingual_v2",
)

```

```go
package main

import (
	"fmt"
	"strings"
	"net/http"
	"io"
)

func main() {

	url := "https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream/with-timestamps?output_format=mp3_44100_128"

	payload := strings.NewReader("{\n  \"text\": \"The first move is what sets everything in motion.\",\n  \"model_id\": \"eleven_multilingual_v2\"\n}")

	req, _ := http.NewRequest("POST", url, payload)

	req.Header.Add("Content-Type", "application/json")

	res, _ := http.DefaultClient.Do(req)

	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)

	fmt.Println(res)
	fmt.Println(string(body))

}
```

```ruby
require 'uri'
require 'net/http'

url = URI("https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream/with-timestamps?output_format=mp3_44100_128")

http = Net::HTTP.new(url.host, url.port)
http.use_ssl = true

request = Net::HTTP::Post.new(url)
request["Content-Type"] = 'application/json'
request.body = "{\n  \"text\": \"The first move is what sets everything in motion.\",\n  \"model_id\": \"eleven_multilingual_v2\"\n}"

response = http.request(request)
puts response.read_body
```

```java
import com.mashape.unirest.http.HttpResponse;
import com.mashape.unirest.http.Unirest;

HttpResponse<String> response = Unirest.post("https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream/with-timestamps?output_format=mp3_44100_128")
  .header("Content-Type", "application/json")
  .body("{\n  \"text\": \"The first move is what sets everything in motion.\",\n  \"model_id\": \"eleven_multilingual_v2\"\n}")
  .asString();
```

```php
<?php
require_once('vendor/autoload.php');

$client = new \GuzzleHttp\Client();

$response = $client->request('POST', 'https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream/with-timestamps?output_format=mp3_44100_128', [
  'body' => '{
  "text": "The first move is what sets everything in motion.",
  "model_id": "eleven_multilingual_v2"
}',
  'headers' => [
    'Content-Type' => 'application/json',
  ],
]);

echo $response->getBody();
```

```csharp
using RestSharp;

var client = new RestClient("https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream/with-timestamps?output_format=mp3_44100_128");
var request = new RestRequest(Method.POST);
request.AddHeader("Content-Type", "application/json");
request.AddParameter("application/json", "{\n  \"text\": \"The first move is what sets everything in motion.\",\n  \"model_id\": \"eleven_multilingual_v2\"\n}", ParameterType.RequestBody);
IRestResponse response = client.Execute(request);
```

```swift
import Foundation

let headers = ["Content-Type": "application/json"]
let parameters = [
  "text": "The first move is what sets everything in motion.",
  "model_id": "eleven_multilingual_v2"
] as [String : Any]

let postData = JSONSerialization.data(withJSONObject: parameters, options: [])

let request = NSMutableURLRequest(url: NSURL(string: "https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream/with-timestamps?output_format=mp3_44100_128")! as URL,
                                        cachePolicy: .useProtocolCachePolicy,
                                    timeoutInterval: 10.0)
request.httpMethod = "POST"
request.allHTTPHeaderFields = headers
request.httpBody = postData as Data

let session = URLSession.shared
let dataTask = session.dataTask(with: request as URLRequest, completionHandler: { (data, response, error) -> Void in
  if (error != nil) {
    print(error as Any)
  } else {
    let httpResponse = response as? HTTPURLResponse
    print(httpResponse)
  }
})

dataTask.resume()
```

# WebSocket

GET /v1/text-to-speech/{voice_id}/stream-input

The Text-to-Speech WebSockets API is designed to generate audio from partial text input
while ensuring consistency throughout the generated audio. Although highly flexible,
the WebSockets API isn't a one-size-fits-all solution. It's well-suited for scenarios where:
  * The input text is being streamed or generated in chunks.
  * Word-to-audio alignment information is required.

However, it may not be the best choice when:
  * The entire input text is available upfront. Given that the generations are partial,
    some buffering is involved, which could potentially result in slightly higher latency compared
    to a standard HTTP request.
  * You want to quickly experiment or prototype. Working with WebSockets can be harder and more
    complex than using a standard HTTP API, which might slow down rapid development and testing.

Reference: https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input

## AsyncAPI Specification

```yaml
asyncapi: 2.6.0
info:
  title: V 1 Text To Speech Voice Id Stream Input
  version: subpackage_v1TextToSpeechVoiceIdStreamInput.v1TextToSpeechVoiceIdStreamInput
  description: >-
    The Text-to-Speech WebSockets API is designed to generate audio from partial
    text input

    while ensuring consistency throughout the generated audio. Although highly
    flexible,

    the WebSockets API isn't a one-size-fits-all solution. It's well-suited for
    scenarios where:
      * The input text is being streamed or generated in chunks.
      * Word-to-audio alignment information is required.

    However, it may not be the best choice when:
      * The entire input text is available upfront. Given that the generations are partial,
        some buffering is involved, which could potentially result in slightly higher latency compared
        to a standard HTTP request.
      * You want to quickly experiment or prototype. Working with WebSockets can be harder and more
        complex than using a standard HTTP API, which might slow down rapid development and testing.
channels:
  /v1/text-to-speech/{voice_id}/stream-input:
    description: >-
      The Text-to-Speech WebSockets API is designed to generate audio from
      partial text input

      while ensuring consistency throughout the generated audio. Although highly
      flexible,

      the WebSockets API isn't a one-size-fits-all solution. It's well-suited
      for scenarios where:
        * The input text is being streamed or generated in chunks.
        * Word-to-audio alignment information is required.

      However, it may not be the best choice when:
        * The entire input text is available upfront. Given that the generations are partial,
          some buffering is involved, which could potentially result in slightly higher latency compared
          to a standard HTTP request.
        * You want to quickly experiment or prototype. Working with WebSockets can be harder and more
          complex than using a standard HTTP API, which might slow down rapid development and testing.
    parameters:
      voice_id:
        description: The unique identifier for the voice to use in the TTS process.
        schema:
          type: string
    bindings:
      ws:
        query:
          type: object
          properties:
            authorization:
              type: string
            single_use_token:
              type: string
            model_id:
              type: string
            language_code:
              type: string
            enable_logging:
              type: boolean
              default: true
            enable_ssml_parsing:
              type: boolean
              default: false
            output_format:
              $ref: '#/components/schemas/type_:TextToSpeechOutputFormatEnum'
            inactivity_timeout:
              type: integer
              default: 20
            sync_alignment:
              type: boolean
              default: false
            auto_mode:
              type: boolean
              default: false
            apply_text_normalization:
              $ref: >-
                #/components/schemas/type_:TextToSpeechApplyTextNormalizationEnum
            seed:
              type: integer
        headers:
          type: object
          properties:
            xi-api-key:
              type: string
    publish:
      operationId: v-1-text-to-speech-voice-id-stream-input-publish
      summary: Server message
      message:
        name: subscribe
        payload:
          $ref: >-
            #/components/schemas/type_v1TextToSpeechVoiceIdStreamInput:receiveMessage
    subscribe:
      operationId: v-1-text-to-speech-voice-id-stream-input-subscribe
      summary: Client message
      message:
        name: publish
        payload:
          $ref: >-
            #/components/schemas/type_v1TextToSpeechVoiceIdStreamInput:sendMessage
servers:
  Production:
    url: wss://api.elevenlabs.io/
    protocol: wss
    x-default: true
  Production US:
    url: wss://api.us.elevenlabs.io/
    protocol: wss
  Production EU:
    url: wss://api.eu.residency.elevenlabs.io/
    protocol: wss
  Production India:
    url: wss://api.in.residency.elevenlabs.io/
    protocol: wss
components:
  schemas:
    type_:TextToSpeechOutputFormatEnum:
      type: string
      enum:
        - mp3_22050_32
        - mp3_44100_32
        - mp3_44100_64
        - mp3_44100_96
        - mp3_44100_128
        - mp3_44100_192
        - pcm_8000
        - pcm_16000
        - pcm_22050
        - pcm_24000
        - pcm_44100
        - ulaw_8000
        - alaw_8000
        - opus_48000_32
        - opus_48000_64
        - opus_48000_96
        - opus_48000_128
        - opus_48000_192
      description: The output audio format
      title: TextToSpeechOutputFormatEnum
    type_:TextToSpeechApplyTextNormalizationEnum:
      type: string
      enum:
        - auto
        - 'on'
        - 'off'
      default: auto
      description: >-
        This parameter controls text normalization with three modes - 'auto',
        'on', and 'off'. When set to 'auto', the system will automatically
        decide whether to apply text normalization (e.g., spelling out numbers).
        With 'on', text normalization will always be applied, while with 'off',
        it will be skipped. For the 'eleven_flash_v2_5' model, text
        normalization can only be enabled with Enterprise plans. Defaults to
        'auto'.
      title: TextToSpeechApplyTextNormalizationEnum
    type_:NormalizedAlignment:
      type: object
      properties:
        charStartTimesMs:
          type: array
          items:
            type: integer
          description: >-
            A list of starting times (in milliseconds) for each character in the
            normalized text as it

            corresponds to the audio. For instance, the character 'H' starts at
            time 0 ms in the audio.

            Note these times are relative to the returned chunk from the model,
            and not the

            full audio response.
        charDurationsMs:
          type: array
          items:
            type: integer
          description: >-
            A list of durations (in milliseconds) for each character in the
            normalized text as it

            corresponds to the audio. For instance, the character 'H' lasts for
            3 ms in the audio.

            Note these times are relative to the returned chunk from the model,
            and not the

            full audio response.
        chars:
          type: array
          items:
            type: string
          description: >-
            A list of characters in the normalized text sequence. For instance,
            the first character is 'H'.

            Note that this list may contain spaces, punctuation, and other
            special characters.

            The length of this list should be the same as the lengths of
            `charStartTimesMs` and `charDurationsMs`.
      description: >-
        Alignment information for the generated audio given the input normalized
        text sequence.
      title: NormalizedAlignment
    type_:Alignment:
      type: object
      properties:
        charStartTimesMs:
          type: array
          items:
            type: integer
          description: >-
            A list of starting times (in milliseconds) for each character in the
            text as it

            corresponds to the audio. For instance, the character 'H' starts at
            time 0 ms in the audio.

            Note these times are relative to the returned chunk from the model,
            and not the

            full audio response.
        charDurationsMs:
          type: array
          items:
            type: integer
          description: >-
            A list of durations (in milliseconds) for each character in the text
            as it

            corresponds to the audio. For instance, the character 'H' lasts for
            3 ms in the audio.

            Note these times are relative to the returned chunk from the model,
            and not the

            full audio response.
        chars:
          type: array
          items:
            type: string
          description: >-
            A list of characters in the text sequence. For instance, the first
            character is 'H'.

            Note that this list may contain spaces, punctuation, and other
            special characters.

            The length of this list should be the same as the lengths of
            `charStartTimesMs` and `charDurationsMs`.
      description: >-
        Alignment information for the generated audio given the input text
        sequence.
      title: Alignment
    type_:AudioOutput:
      type: object
      properties:
        audio:
          type: string
          description: >-
            A generated partial audio chunk, encoded using the selected
            output_format, by default this

            is MP3 encoded as a base64 string.
        normalizedAlignment:
          $ref: '#/components/schemas/type_:NormalizedAlignment'
        alignment:
          $ref: '#/components/schemas/type_:Alignment'
      required:
        - audio
      title: AudioOutput
    type_:FinalOutput:
      type: object
      properties:
        isFinal:
          type: boolean
          enum:
            - true
          description: >-
            Indicates if the generation is complete. If set to `True`, `audio`
            will be null.
      title: FinalOutput
    type_v1TextToSpeechVoiceIdStreamInput:receiveMessage:
      oneOf:
        - $ref: '#/components/schemas/type_:AudioOutput'
        - $ref: '#/components/schemas/type_:FinalOutput'
      description: Receive messages from the WebSocket
      title: receiveMessage
    type_:RealtimeVoiceSettings:
      type: object
      properties:
        stability:
          type: number
          format: double
          default: 0.5
          description: Defines the stability for voice settings.
        similarity_boost:
          type: number
          format: double
          default: 0.75
          description: Defines the similarity boost for voice settings.
        style:
          type: number
          format: double
          default: 0
          description: >-
            Defines the style for voice settings. This parameter is available on
            V2+ models.
        use_speaker_boost:
          type: boolean
          default: true
          description: >-
            Defines the use speaker boost for voice settings. This parameter is
            available on V2+ models.
        speed:
          type: number
          format: double
          default: 1
          description: >-
            Controls the speed of the generated speech. Values range from 0.7 to
            1.2, with 1.0 being the default speed.
      title: RealtimeVoiceSettings
    type_:GenerationConfig:
      type: object
      properties:
        chunk_length_schedule:
          type: array
          items:
            type: number
            format: double
          description: >-
            This is an advanced setting that most users shouldn't need to use.
            It relates to our

            generation schedule.


            Our WebSocket service incorporates a buffer system designed to
            optimize the Time To First Byte (TTFB) while maintaining
            high-quality streaming.


            All text sent to the WebSocket endpoint is added to this buffer and
            only when that buffer reaches a certain size is an audio generation
            attempted. This is because our model provides higher quality audio
            when the model has longer inputs, and can deduce more context about
            how the text should be delivered.


            The buffer ensures smooth audio data delivery and is automatically
            emptied with a final audio generation either when the stream is
            closed, or upon sending a `flush` command. We have advanced settings
            for changing the chunk schedule, which can improve latency at the
            cost of quality by generating audio more frequently with smaller
            text inputs.


            The `chunk_length_schedule` determines the minimum amount of text
            that needs to be sent and present in our

            buffer before audio starts being generated. This is to maximise the
            amount of context available to

            the model to improve audio quality, whilst balancing latency of the
            returned audio chunks.


            The default value for `chunk_length_schedule` is: [120, 160, 250,
            290].


            This means that the first chunk of audio will not be generated until
            you send text that

            totals at least 120 characters long. The next chunk of audio will
            only be generated once a

            further 160 characters have been sent. The third audio chunk will be
            generated after the

            next 250 characters. Then the fourth, and beyond, will be generated
            in sets of at least 290 characters.


            Customize this array to suit your needs. If you want to generate
            audio more frequently

            to optimise latency, you can reduce the values in the array. Note
            that setting the values

            too low may result in lower quality audio. Please test and adjust as
            needed.


            Each item should be in the range 50-500.
      title: GenerationConfig
    type_:PronunciationDictionaryLocator:
      type: object
      properties:
        pronunciation_dictionary_id:
          type: string
          description: The unique identifier of the pronunciation dictionary
        version_id:
          type: string
          description: The version identifier of the pronunciation dictionary
      required:
        - pronunciation_dictionary_id
        - version_id
      description: Identifies a specific pronunciation dictionary to use
      title: PronunciationDictionaryLocator
    type_:InitializeConnection:
      type: object
      properties:
        text:
          type: string
          enum:
            - ' '
          description: The initial text that must be sent is a blank space.
        voice_settings:
          $ref: '#/components/schemas/type_:RealtimeVoiceSettings'
        generation_config:
          $ref: '#/components/schemas/type_:GenerationConfig'
        pronunciation_dictionary_locators:
          type: array
          items:
            $ref: '#/components/schemas/type_:PronunciationDictionaryLocator'
          description: >-
            Optional list of pronunciation dictionary locators. If provided,
            these dictionaries will be used to

            modify pronunciation of matching text. Must only be provided in the
            first message.


            Note: Pronunciation dictionary matches will only be respected within
            a provided chunk.
        xi-api-key:
          type: string
          description: >-
            Your ElevenLabs API key. This can only be included in the first
            message and is not needed if present in the header.
        authorization:
          type: string
          description: >-
            Your authorization bearer token. This can only be included in the
            first message and is not needed if present in the header.
      required:
        - text
      title: InitializeConnection
    type_:SendText:
      type: object
      properties:
        text:
          type: string
          description: >-
            The text to be sent to the API for audio generation. Should always
            end with a single space string.
        try_trigger_generation:
          type: boolean
          default: false
          description: >-
            This is an advanced setting that most users shouldn't need to use.
            It relates to our generation schedule.


            Use this to attempt to immediately trigger the generation of audio,
            overriding the `chunk_length_schedule`.

            Unlike flush, `try_trigger_generation` will only generate audio if
            our

            buffer contains more than a minimum

            threshold of characters, this is to ensure a higher quality response
            from our model.


            Note that overriding the chunk schedule to generate small amounts of

            text may result in lower quality audio, therefore, only use this
            parameter if you

            really need text to be processed immediately. We generally recommend
            keeping the default value of

            `false` and adjusting the `chunk_length_schedule` in the
            `generation_config` instead.
        voice_settings:
          $ref: '#/components/schemas/type_:RealtimeVoiceSettings'
          description: >-
            The voice settings field can be provided in the first
            `InitializeConnection` message and then must either be not provided
            or not changed.
        generator_config:
          $ref: '#/components/schemas/type_:GenerationConfig'
          description: >-
            The generator config field can be provided in the first
            `InitializeConnection` message and then must either be not provided
            or not changed.
        flush:
          type: boolean
          default: false
          description: >-
            Flush forces the generation of audio. Set this value to true when
            you have finished sending text, but want to keep the websocket
            connection open.


            This is useful when you want to ensure that the last chunk of audio
            is generated even when the length of text sent is smaller than the
            value set in chunk_length_schedule (e.g. 120 or 50).
      required:
        - text
      title: SendText
    type_:CloseConnection:
      type: object
      properties:
        text:
          type: string
          enum:
            - ''
          description: End the stream with an empty string
      required:
        - text
      title: CloseConnection
    type_v1TextToSpeechVoiceIdStreamInput:sendMessage:
      oneOf:
        - $ref: '#/components/schemas/type_:InitializeConnection'
        - $ref: '#/components/schemas/type_:SendText'
        - $ref: '#/components/schemas/type_:CloseConnection'
      description: Send messages to the WebSocket
      title: sendMessage

```

# Multi-Context WebSocket

GET /v1/text-to-speech/{voice_id}/multi-stream-input

The Multi-Context Text-to-Speech WebSockets API allows for generating audio from text input
while managing multiple independent audio generation streams (contexts) over a single WebSocket connection.
This is useful for scenarios requiring concurrent or interleaved audio generations, such as dynamic
conversational AI applications.

Each context, identified by a context id, maintains its own state. You can send text to specific
contexts, flush them, or close them independently. A `close_socket` message can be used to terminate
the entire connection gracefully.

For more information on best practices for how to use this API, please see the [multi context websocket guide](/docs/developers/guides/cookbooks/multi-context-web-socket).

Reference: https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-multi-stream-input

## AsyncAPI Specification

```yaml
asyncapi: 2.6.0
info:
  title: V 1 Text To Speech Voice Id Multi Stream Input
  version: >-
    subpackage_v1TextToSpeechVoiceIdMultiStreamInput.v1TextToSpeechVoiceIdMultiStreamInput
  description: >-
    The Multi-Context Text-to-Speech WebSockets API allows for generating audio
    from text input

    while managing multiple independent audio generation streams (contexts) over
    a single WebSocket connection.

    This is useful for scenarios requiring concurrent or interleaved audio
    generations, such as dynamic

    conversational AI applications.


    Each context, identified by a context id, maintains its own state. You can
    send text to specific

    contexts, flush them, or close them independently. A `close_socket` message
    can be used to terminate

    the entire connection gracefully.


    For more information on best practices for how to use this API, please see
    the [multi context websocket
    guide](/docs/developers/guides/cookbooks/multi-context-web-socket).
channels:
  /v1/text-to-speech/{voice_id}/multi-stream-input:
    description: >-
      The Multi-Context Text-to-Speech WebSockets API allows for generating
      audio from text input

      while managing multiple independent audio generation streams (contexts)
      over a single WebSocket connection.

      This is useful for scenarios requiring concurrent or interleaved audio
      generations, such as dynamic

      conversational AI applications.


      Each context, identified by a context id, maintains its own state. You can
      send text to specific

      contexts, flush them, or close them independently. A `close_socket`
      message can be used to terminate

      the entire connection gracefully.


      For more information on best practices for how to use this API, please see
      the [multi context websocket
      guide](/docs/developers/guides/cookbooks/multi-context-web-socket).
    parameters:
      voice_id:
        description: The unique identifier for the voice to use in the TTS process.
        schema:
          type: string
    bindings:
      ws:
        query:
          type: object
          properties:
            authorization:
              type: string
            single_use_token:
              type: string
            model_id:
              type: string
            language_code:
              type: string
            enable_logging:
              type: boolean
              default: true
            enable_ssml_parsing:
              type: boolean
              default: false
            output_format:
              $ref: '#/components/schemas/type_:TextToSpeechOutputFormatEnum'
            inactivity_timeout:
              type: integer
              default: 20
            sync_alignment:
              type: boolean
              default: false
            auto_mode:
              type: boolean
              default: false
            apply_text_normalization:
              $ref: >-
                #/components/schemas/type_:TextToSpeechApplyTextNormalizationEnum
            seed:
              type: integer
        headers:
          type: object
          properties:
            xi-api-key:
              type: string
    publish:
      operationId: v-1-text-to-speech-voice-id-multi-stream-input-publish
      summary: Server message
      message:
        name: subscribe
        payload:
          $ref: >-
            #/components/schemas/type_v1TextToSpeechVoiceIdMultiStreamInput:receiveMessageMulti
    subscribe:
      operationId: v-1-text-to-speech-voice-id-multi-stream-input-subscribe
      summary: Client message
      message:
        name: publish
        payload:
          $ref: >-
            #/components/schemas/type_v1TextToSpeechVoiceIdMultiStreamInput:sendMessageMulti
servers:
  Production:
    url: wss://api.elevenlabs.io/
    protocol: wss
    x-default: true
  Production US:
    url: wss://api.us.elevenlabs.io/
    protocol: wss
  Production EU:
    url: wss://api.eu.residency.elevenlabs.io/
    protocol: wss
  Production India:
    url: wss://api.in.residency.elevenlabs.io/
    protocol: wss
components:
  schemas:
    type_:TextToSpeechOutputFormatEnum:
      type: string
      enum:
        - mp3_22050_32
        - mp3_44100_32
        - mp3_44100_64
        - mp3_44100_96
        - mp3_44100_128
        - mp3_44100_192
        - pcm_8000
        - pcm_16000
        - pcm_22050
        - pcm_24000
        - pcm_44100
        - ulaw_8000
        - alaw_8000
        - opus_48000_32
        - opus_48000_64
        - opus_48000_96
        - opus_48000_128
        - opus_48000_192
      description: The output audio format
      title: TextToSpeechOutputFormatEnum
    type_:TextToSpeechApplyTextNormalizationEnum:
      type: string
      enum:
        - auto
        - 'on'
        - 'off'
      default: auto
      description: >-
        This parameter controls text normalization with three modes - 'auto',
        'on', and 'off'. When set to 'auto', the system will automatically
        decide whether to apply text normalization (e.g., spelling out numbers).
        With 'on', text normalization will always be applied, while with 'off',
        it will be skipped. For the 'eleven_flash_v2_5' model, text
        normalization can only be enabled with Enterprise plans. Defaults to
        'auto'.
      title: TextToSpeechApplyTextNormalizationEnum
    type_:NormalizedAlignment:
      type: object
      properties:
        charStartTimesMs:
          type: array
          items:
            type: integer
          description: >-
            A list of starting times (in milliseconds) for each character in the
            normalized text as it

            corresponds to the audio. For instance, the character 'H' starts at
            time 0 ms in the audio.

            Note these times are relative to the returned chunk from the model,
            and not the

            full audio response.
        charDurationsMs:
          type: array
          items:
            type: integer
          description: >-
            A list of durations (in milliseconds) for each character in the
            normalized text as it

            corresponds to the audio. For instance, the character 'H' lasts for
            3 ms in the audio.

            Note these times are relative to the returned chunk from the model,
            and not the

            full audio response.
        chars:
          type: array
          items:
            type: string
          description: >-
            A list of characters in the normalized text sequence. For instance,
            the first character is 'H'.

            Note that this list may contain spaces, punctuation, and other
            special characters.

            The length of this list should be the same as the lengths of
            `charStartTimesMs` and `charDurationsMs`.
      description: >-
        Alignment information for the generated audio given the input normalized
        text sequence.
      title: NormalizedAlignment
    type_:Alignment:
      type: object
      properties:
        charStartTimesMs:
          type: array
          items:
            type: integer
          description: >-
            A list of starting times (in milliseconds) for each character in the
            text as it

            corresponds to the audio. For instance, the character 'H' starts at
            time 0 ms in the audio.

            Note these times are relative to the returned chunk from the model,
            and not the

            full audio response.
        charDurationsMs:
          type: array
          items:
            type: integer
          description: >-
            A list of durations (in milliseconds) for each character in the text
            as it

            corresponds to the audio. For instance, the character 'H' lasts for
            3 ms in the audio.

            Note these times are relative to the returned chunk from the model,
            and not the

            full audio response.
        chars:
          type: array
          items:
            type: string
          description: >-
            A list of characters in the text sequence. For instance, the first
            character is 'H'.

            Note that this list may contain spaces, punctuation, and other
            special characters.

            The length of this list should be the same as the lengths of
            `charStartTimesMs` and `charDurationsMs`.
      description: >-
        Alignment information for the generated audio given the input text
        sequence.
      title: Alignment
    type_:AudioOutputMulti:
      type: object
      properties:
        audio:
          type: string
          description: Base64 encoded audio chunk.
        normalizedAlignment:
          $ref: '#/components/schemas/type_:NormalizedAlignment'
        alignment:
          $ref: '#/components/schemas/type_:Alignment'
        contextId:
          type: string
          description: The contextId for which this audio is.
      required:
        - audio
      description: Server payload containing an audio chunk for a specific context.
      title: AudioOutputMulti
    type_:FinalOutputMulti:
      type: object
      properties:
        isFinal:
          type: boolean
          enum:
            - true
          description: Indicates this is the final message for the context.
        contextId:
          type: string
          description: The context_id for which this is the final message.
      required:
        - isFinal
      description: Server payload indicating the final output for a specific context.
      title: FinalOutputMulti
    type_v1TextToSpeechVoiceIdMultiStreamInput:receiveMessageMulti:
      oneOf:
        - $ref: '#/components/schemas/type_:AudioOutputMulti'
        - $ref: '#/components/schemas/type_:FinalOutputMulti'
      description: Receive messages from the multi-context WebSocket.
      title: receiveMessageMulti
    type_:RealtimeVoiceSettings:
      type: object
      properties:
        stability:
          type: number
          format: double
          default: 0.5
          description: Defines the stability for voice settings.
        similarity_boost:
          type: number
          format: double
          default: 0.75
          description: Defines the similarity boost for voice settings.
        style:
          type: number
          format: double
          default: 0
          description: >-
            Defines the style for voice settings. This parameter is available on
            V2+ models.
        use_speaker_boost:
          type: boolean
          default: true
          description: >-
            Defines the use speaker boost for voice settings. This parameter is
            available on V2+ models.
        speed:
          type: number
          format: double
          default: 1
          description: >-
            Controls the speed of the generated speech. Values range from 0.7 to
            1.2, with 1.0 being the default speed.
      title: RealtimeVoiceSettings
    type_:GenerationConfig:
      type: object
      properties:
        chunk_length_schedule:
          type: array
          items:
            type: number
            format: double
          description: >-
            This is an advanced setting that most users shouldn't need to use.
            It relates to our

            generation schedule.


            Our WebSocket service incorporates a buffer system designed to
            optimize the Time To First Byte (TTFB) while maintaining
            high-quality streaming.


            All text sent to the WebSocket endpoint is added to this buffer and
            only when that buffer reaches a certain size is an audio generation
            attempted. This is because our model provides higher quality audio
            when the model has longer inputs, and can deduce more context about
            how the text should be delivered.


            The buffer ensures smooth audio data delivery and is automatically
            emptied with a final audio generation either when the stream is
            closed, or upon sending a `flush` command. We have advanced settings
            for changing the chunk schedule, which can improve latency at the
            cost of quality by generating audio more frequently with smaller
            text inputs.


            The `chunk_length_schedule` determines the minimum amount of text
            that needs to be sent and present in our

            buffer before audio starts being generated. This is to maximise the
            amount of context available to

            the model to improve audio quality, whilst balancing latency of the
            returned audio chunks.


            The default value for `chunk_length_schedule` is: [120, 160, 250,
            290].


            This means that the first chunk of audio will not be generated until
            you send text that

            totals at least 120 characters long. The next chunk of audio will
            only be generated once a

            further 160 characters have been sent. The third audio chunk will be
            generated after the

            next 250 characters. Then the fourth, and beyond, will be generated
            in sets of at least 290 characters.


            Customize this array to suit your needs. If you want to generate
            audio more frequently

            to optimise latency, you can reduce the values in the array. Note
            that setting the values

            too low may result in lower quality audio. Please test and adjust as
            needed.


            Each item should be in the range 50-500.
      title: GenerationConfig
    type_:PronunciationDictionaryLocator:
      type: object
      properties:
        pronunciation_dictionary_id:
          type: string
          description: The unique identifier of the pronunciation dictionary
        version_id:
          type: string
          description: The version identifier of the pronunciation dictionary
      required:
        - pronunciation_dictionary_id
        - version_id
      description: Identifies a specific pronunciation dictionary to use
      title: PronunciationDictionaryLocator
    type_:InitializeConnectionMulti:
      type: object
      properties:
        text:
          type: string
          enum:
            - ' '
          description: Must be a single space character to initiate the context.
        voice_settings:
          $ref: '#/components/schemas/type_:RealtimeVoiceSettings'
        generation_config:
          $ref: '#/components/schemas/type_:GenerationConfig'
        pronunciation_dictionary_locators:
          type: array
          items:
            $ref: '#/components/schemas/type_:PronunciationDictionaryLocator'
          description: Optional pronunciation dictionaries for this context.
        xi_api_key:
          type: string
          description: >-
            Your ElevenLabs API key (if not in header). For this context's first
            message only.
        authorization:
          type: string
          description: >-
            Your authorization bearer token (if not in header). For this
            context's first message only.
        context_id:
          type: string
          description: >-
            A unique identifier for the first context created in the websocket.
            If not provided, a default context will be used.
      required:
        - text
      description: >-
        Payload to initialize a new context in a multi-stream WebSocket
        connection.
      title: InitializeConnectionMulti
    type_:InitialiseContext:
      type: object
      properties:
        text:
          type: string
          description: The initial text to synthesize. Should end with a single space.
        voice_settings:
          $ref: '#/components/schemas/type_:RealtimeVoiceSettings'
        generation_config:
          $ref: '#/components/schemas/type_:GenerationConfig'
        pronunciation_dictionary_locators:
          type: array
          items:
            $ref: '#/components/schemas/type_:PronunciationDictionaryLocator'
          description: >-
            Optional list of pronunciation dictionary locators to be used for
            this context.
        xi_api_key:
          type: string
          description: >-
            Your ElevenLabs API key. Required if not provided in the WebSocket
            connection's header or query parameters. This applies to the
            (re)initialization of this specific context.
        authorization:
          type: string
          description: >-
            Your authorization bearer token. Required if not provided in the
            WebSocket connection's header or query parameters. This applies to
            the (re)initialization of this specific context.
        context_id:
          type: string
          description: >-
            An identifier for the text-to-speech context. If omitted, a default
            context ID may be assigned by the server. If provided, this message
            will create a new context with this ID or re-initialize an existing
            one with the new settings and text.
      required:
        - text
      description: >-
        Payload to initialize or re-initialize a TTS context with specific
        settings and initial text for multi-stream connections.
      title: InitialiseContext
    type_:SendTextMulti:
      type: object
      properties:
        text:
          type: string
          description: Text to synthesize. Should end with a single space.
        context_id:
          type: string
          description: The target context_id for this text.
        flush:
          type: boolean
          default: false
          description: >-
            If true, flushes the audio buffer for the specified context. If
            false, the text will be appended to the buffer to be generated.
      required:
        - text
      description: Payload to send text for synthesis to an existing context.
      title: SendTextMulti
    type_:FlushContext:
      type: object
      properties:
        context_id:
          type: string
          description: The context_id to flush.
        text:
          type: string
          description: The text to append to the buffer to be flushed.
        flush:
          type: boolean
          default: false
          description: >-
            If true, flushes the audio buffer for the specified context. If
            false, the context will remain open and the text will be appended to
            the buffer to be generated.
      required:
        - context_id
        - flush
      description: Payload to flush the audio buffer for a specific context.
      title: FlushContext
    type_:CloseContext:
      type: object
      properties:
        context_id:
          type: string
          description: The context_id to close.
        close_context:
          type: boolean
          default: false
          description: >-
            Must set the close_context to true, to close the specified context.
            If false, the context will remain open and the text will be ignored.
            If set to true, the context will close. If it has already been set
            to flush it will continue flushing. The same context id can be used
            again but will not be linked to the previous context with the same
            name.
      required:
        - context_id
        - close_context
      description: Payload to close a specific TTS context.
      title: CloseContext
    type_:CloseSocket:
      type: object
      properties:
        close_socket:
          type: boolean
          default: false
          description: >-
            If true, closes all contexts and closes the entire WebSocket
            connection. Any context that was previously set to flush will wait
            to flush before closing.
      description: Payload to signal closing the entire WebSocket connection.
      title: CloseSocket
    type_:KeepContextAlive:
      type: object
      properties:
        text:
          type: string
          enum:
            - ''
          description: >-
            An empty string. This text is ignored by the server but its presence
            resets the inactivity timeout for the specified context.
        context_id:
          type: string
          description: The identifier of the context to keep alive.
      required:
        - text
        - context_id
      description: >-
        Payload to keep a specific context alive by resetting its inactivity
        timeout. Empty text is ignored but resets the clock.
      title: KeepContextAlive
    type_v1TextToSpeechVoiceIdMultiStreamInput:sendMessageMulti:
      oneOf:
        - $ref: '#/components/schemas/type_:InitializeConnectionMulti'
        - $ref: '#/components/schemas/type_:InitialiseContext'
        - $ref: '#/components/schemas/type_:SendTextMulti'
        - $ref: '#/components/schemas/type_:FlushContext'
        - $ref: '#/components/schemas/type_:CloseContext'
        - $ref: '#/components/schemas/type_:CloseSocket'
        - $ref: '#/components/schemas/type_:KeepContextAlive'
      description: Send messages to the multi-context WebSocket.
      title: sendMessageMulti

```
