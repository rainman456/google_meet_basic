# videochat

## Description
 This is a very basic implementation of a google meet to understand how it works it's adapted from my other repo`https://github.com/rainman456/videochat` , which uses gorrilla websockets and the Webrtc api and  makes uses of rooms and client ids to automatically connects two peers who want to communicate by inserting room id think of the id  as the meet link, here is the live preview: (https://google-meet-testing.onrender.com/) it's very basic and still needs to be worked on anyways do enjoy it. I look forward to advancing this project sooner or later.

## Usage
 You could run this locally or on online using a host of your choice I chose render for this ,to run locally 

 `go mod tidy && go run main.go `

 If you would  like to run on render sign up with your repo provider e.g github or gitlab and use this as the build command

 `go mod tidy && go build -tags netgo -ldflags '-s -w' -o app`

 Use this as the run command
 `./app`

 You could choose to specify the port

 I advice getting your turn server credentials from `https://dashboard.metered.ca/` and intialize the ICE servers in the main.js file at the top 

 `const servers=[]`

 I dont know much about javascript so the javascript code is gpt modified boilerplate code from fireship repo

## Contribution
# If you'd like to contribute to this repo please create a pull request with your additions
