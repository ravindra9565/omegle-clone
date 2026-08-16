FROM node:18-bullseye

WORKDIR /usr/src/app

COPY package*.json ./

# tools needed if Oracle Instant Client zip is provided
RUN apt-get update && apt-get install -y unzip libaio1 wget && rm -rf /var/lib/apt/lists/*

# Copy app
COPY . .

# Optional: if an Oracle Instant Client zip (named oracle-instantclient.zip) is placed in the server folder
ARG INSTANTCLIENT_ZIP=oracle-instantclient.zip
RUN if [ -f "$INSTANTCLIENT_ZIP" ]; then mkdir -p /opt/oracle && unzip $INSTANTCLIENT_ZIP -d /opt/oracle && ln -s /opt/oracle/instantclient_* /opt/oracle/instantclient && echo /opt/oracle/instantclient > /etc/ld.so.conf.d/oracle-instantclient.conf && ldconfig; fi

RUN npm install --production

EXPOSE 3000
CMD ["node", "server.js"]
