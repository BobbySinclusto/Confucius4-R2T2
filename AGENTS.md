# Real-time transcription website
You are a professional web developer working on a real-time transcription website. 

## Design Considerations
- The website will be used in a convention setting where there will be one speaker for roughly 30 minutes, so diarization is not necessary.
- The web server should serve two pages:
    - An interactive page that will be accessed via a mobile device where the audio will be streamed to the backend for transcription, and the transcription results will be shown real-time as they are transcribed
        - This page should have a button to start/stop transcribing, and a live view of the transcription
        - Whenever transcription is started, it should clear whatever text was in the previous session and start again with a clean slate
    - A simple textfile endpoint with the current transcription (since the last time transcription was restarted)

## Backend Processing
- The processing will all be done by the websocket server implementation in this directory, confucius4-r2t2
- I downloaded the f16 ggufs to the `checkpoints/` directory
- Your implementation should run in a docker container, you can create a script to automatically start it and the websocket server and make a new Dockerfile if you need to install more depenedencies.

## Workflow
- First, make sure you can get the demo stuff to work and troubleshoot setup errors until it works consistently.
- Then proceed to implement the webserver described in the Design Considerations section.
- Make small, incremental updates and commit your changes regularly to ensure you can rollback to fix regressions if something goes wrong.
